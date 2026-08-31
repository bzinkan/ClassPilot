// ClassPilot - Service Worker
// Handles background heartbeat sending and tab monitoring

// Recovery capabilities live in storage.local so cleanup survives a browser
// restart, but content scripts must never be able to read that storage area.
// Dispatch this restriction before imports or any asynchronous startup work.
function restrictLocalStorageToTrustedContexts(storageArea, runtimeApi) {
  return new Promise((resolve, reject) => {
    const purgeRecovery = () => storageArea?.remove?.('studentSessionRecoveryV1', () => {
      void runtimeApi?.lastError;
    });
    if (!storageArea?.setAccessLevel) {
      purgeRecovery();
      reject(new Error('Trusted-only extension storage is unavailable'));
      return;
    }
    storageArea.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }, () => {
      if (runtimeApi?.lastError) {
        purgeRecovery();
        reject(new Error('Trusted-only extension storage could not be enabled'));
        return;
      }
      resolve();
    });
  });
}

const trustedLocalStorageAccessPromise = restrictLocalStorageToTrustedContexts(
  chrome.storage?.local,
  chrome.runtime,
);
trustedLocalStorageAccessPromise.catch(() => {});

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

const SENTRY_SENSITIVE_KEY_REGEX = /(authorization|cookie|credential|device|email|id$|name|payload|pin|prompt|response|school|student|token)/i;
const SENTRY_URL_KEY_REGEX = /url/i;
const SENTRY_EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const SENTRY_URL_REGEX = /https?:\/\/\S+/i;
const SENTRY_BEARER_REGEX = /(?:bearer\s+)?eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/i;
const SENTRY_OPAQUE_ID_REGEX = /\b(?:[a-f0-9]{8}-[a-f0-9-]{20,}|[A-Za-z0-9_-]{32,})\b/i;
const DIAGNOSTIC_CODE_ALLOWLIST = new Set([
  'AMBIGUOUS_TAB_URL',
  'AUTH_CONTEXT_INCOMPLETE',
  'AUTH_CONTEXT_SUPERSEDED',
  'AUTH_GATE_INVALID_POLICY_FENCE',
  'AUTH_GATE_TIMEOUT',
  'AUTH_MUTATION_SUPERSEDED',
  'CLASSROOM_STATE_INVALID',
  'COMMAND_ACK_AUTHORITY_UNAVAILABLE',
  'COMMAND_ACK_BINDING_MISMATCH',
  'COMMAND_ACK_INVALID_TRANSITION',
  'COMMAND_ACK_MALFORMED',
  'COMMAND_ACK_TARGET_EXPIRED',
  'COMMAND_ACK_TARGET_GONE',
  'COMMAND_AUTHORITY_MISMATCH',
  'COMMAND_AUTHORITY_MISSING',
  'COMMAND_FAILED',
  'SAFETY_EVIDENCE_TIMEOUT',
  'RESTRICTION_SSO_STALE_STORAGE',
  'SCREENSHOT_PAUSED_UNOBSERVED',
  'STALE_TAB_SNAPSHOT',
  'STUDENT_BINDING_MISMATCH',
  'STUDENT_CHAT_INVALID',
  'STUDENT_CHAT_OUTBOX_FULL',
  'STUDENT_CHAT_SESSION_REQUIRED',
  'TAB_CLOSE_CAPABILITY_REQUIRED',
  'TAB_CLOSE_FAILED',
  'TAB_REF_NOT_FOUND',
  'TAB_SNAPSHOT_REVISION_REQUIRED',
  'TAB_TARGET_REQUIRED',
  'TAB_URL_NOT_FOUND',
  'UNSUPPORTED_CLASSROOM_STATE_SCHEMA',
]);

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
  if (SENTRY_EMAIL_REGEX.test(value)
    || SENTRY_BEARER_REGEX.test(value)
    || SENTRY_OPAQUE_ID_REGEX.test(value)) {
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

function scrubSentryMessage(value, fallback) {
  const raw = String(value || '');
  const scrubbed = scrubSentryString(raw, 'message');
  if (scrubbed === '[redacted]') return scrubbed;
  const diagnosticCode = raw.trim();
  if (DIAGNOSTIC_CODE_ALLOWLIST.has(diagnosticCode)) return diagnosticCode;
  // Messages and exception values are not a telemetry contract. Keeping only
  // a generic label prevents a future server/body/command error from smuggling
  // names, identifiers, URLs or payload text into Sentry.
  return fallback;
}

const SENTRY_EXCEPTION_TYPE_ALLOWLIST = new Set([
  'AbortError',
  'DOMException',
  'Error',
  'NetworkError',
  'NotAllowedError',
  'NotFoundError',
  'OperationError',
  'QuotaExceededError',
  'SecurityError',
  'TimeoutError',
  'TypeError',
]);
const SENTRY_BREADCRUMB_CATEGORY_ALLOWLIST = new Set([
  'console',
  'fetch',
  'http',
  'navigation',
  'sentry.event',
  'sentry.transaction',
  'ui.click',
  'xhr',
]);
const SENTRY_LEVEL_ALLOWLIST = new Set([
  'debug',
  'error',
  'fatal',
  'info',
  'log',
  'warning',
]);

function safeSentryExceptionType(value) {
  const type = String(value || '').trim();
  return SENTRY_EXCEPTION_TYPE_ALLOWLIST.has(type) ? type : 'Error';
}

function safeSentryBreadcrumbCategory(value) {
  const category = String(value || '').trim();
  return SENTRY_BREADCRUMB_CATEGORY_ALLOWLIST.has(category) ? category : 'extension';
}

function safeSentryLevel(value) {
  const level = String(value || '').trim();
  return SENTRY_LEVEL_ALLOWLIST.has(level) ? level : undefined;
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
      if (event.request) {
        event.request = {
          method: typeof event.request.method === 'string'
            ? event.request.method.slice(0, 12)
            : undefined,
          url: event.request.url ? sanitizeSentryUrl(event.request.url) : undefined,
        };
      }
      if (event.message) {
        event.message = scrubSentryMessage(event.message, 'Extension diagnostic');
      }
      if (event.exception?.values) {
        event.exception.values = event.exception.values.map((exception) => ({
          type: safeSentryExceptionType(exception.type),
          value: scrubSentryMessage(exception.value, 'Extension error'),
          stacktrace: exception.stacktrace?.frames ? {
            frames: exception.stacktrace.frames.map((frame) => ({
              filename: frame.filename ? sanitizeSentryUrl(String(frame.filename)) : undefined,
              function: frame.function
                ? String(frame.function).replace(/[^A-Za-z0-9_$.-]/g, '').slice(0, 120)
                : undefined,
              lineno: Number.isSafeInteger(frame.lineno) ? frame.lineno : undefined,
              colno: Number.isSafeInteger(frame.colno) ? frame.colno : undefined,
            })),
          } : undefined,
        }));
      }
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.map((crumb) => ({
          category: safeSentryBreadcrumbCategory(crumb.category),
          level: safeSentryLevel(crumb.level),
          timestamp: crumb.timestamp,
          message: crumb.message
            ? scrubSentryMessage(crumb.message, 'Extension breadcrumb')
            : crumb.message,
        }));
      }
      // Extension events do not need user, request data, arbitrary context,
      // tags, or extras. Removing these surfaces is safer than attempting to
      // enumerate every future payload field.
      delete event.user;
      delete event.contexts;
      delete event.extra;
      delete event.tags;
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
  authContextId: null,
};

let ws = null; // Legacy reference, kept for compatibility checks
let wsConnected = false; // True only after the current WebSocket generation is authenticated
let wsTransportConnected = false;
let wsConnectionGeneration = 0;
let wsAuthenticatedGeneration = 0;
let wsConnectInFlight = null;
let wsConnectInFlightIdentity = null;
let wsMessageProcessingGeneration = 0;
let wsMessageProcessingTail = Promise.resolve();
let wsAuthenticatedResponseGuard = null;
let wsTransportIdentity = null;
let studentAuthInvalidating = false;
let studentAuthCommitPending = false;
let studentAuthCommitPendingGeneration = 0;
let authCommitRecoveryPromise = Promise.resolve();
let resolveAuthCommitRecovery = null;
let rejectAuthCommitRecovery = null;
let studentAuthMutationGeneration = 0;
let activeAuthContextGeneration = -1;
let authContextAbortController = new AbortController();
let lastRetiredStudentMessageContext = null;
let negotiatedProtocolState = null;
let studentAuthMutationTail = Promise.resolve();
let chromeProfileRegistrationInFlight = null;
let manualStudentLoginPendingGeneration = 0;
const manualStudentLoginSuccessfulResponseFailures = new Set();

const CLIENT_PROTOCOL_VERSION = 3;
const EXTENSION_CAPABILITIES = Object.freeze([
  'classroomStateV1',
  'fabStateRevisionV1',
  'exactTabCloseV1',
  'scopedAuthorityChecksV1',
  'authBoundTelemetryV1',
  'exactBindingAckV2',
  'exactTabCloseV2',
  'studentAuthGatePresenceV1',
  'lateSignInRestrictionSsoV1',
  'studentChatIdempotencyV1',
  'screenshotTrackingWindowLeaseV1',
  'screenshotActiveObservationCadenceV1',
  'screenshotObservationLeaseV1',
  'safetyEvidenceCaptureV1',
  'liveViewIceServersV1',
  'kioskLaunchTicketV1',
  'kioskLaunchTicketV2',
  'managedDeviceContinuityV1',
  'screenOnlyUnlockV1',
  'durableChatAckV1',
  'commandAckReceiptV1',
  'classroomOverlayRestoreV1',
  'liveViewNegotiationV1',
  'domainPreservingRestrictionsV1',
]);
const SCOPED_AUTHORITY_DEPENDENT_CAPABILITIES = new Set([
  'authBoundTelemetryV1',
  'exactBindingAckV2',
  'exactTabCloseV2',
  'studentAuthGatePresenceV1',
  'lateSignInRestrictionSsoV1',
  'screenshotTrackingWindowLeaseV1',
  'screenshotActiveObservationCadenceV1',
  'screenshotObservationLeaseV1',
  'managedDeviceContinuityV1',
]);

function extensionProtocolDescriptor() {
  return {
    clientProtocolVersion: CLIENT_PROTOCOL_VERSION,
    extensionVersion: chrome.runtime.getManifest().version,
    capabilities: [...EXTENSION_CAPABILITIES],
  };
}

// Send a message via the WebSocket proxy in the offscreen document
async function wsSend(data, expectedAuthContext = null) {
  if (!wsConnected || wsAuthenticatedGeneration !== wsConnectionGeneration) return false;
  let authContext = expectedAuthContext;
  try {
    authContext = authContext || captureAuthenticatedContext('WebSocket send');
    assertAuthenticatedContextCurrent(authContext, 'WebSocket send');
  } catch (error) {
    if (isAuthContextCancellation(error)) return false;
    throw error;
  }
  if (
    wsTransportIdentity?.connectionGeneration !== wsConnectionGeneration
    || wsTransportIdentity?.authContextId !== authContext.authContextId
    || wsTransportIdentity?.serverOrigin !== authContext.serverOrigin
  ) return false;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  try {
    const response = await sendToOffscreen({
      type: 'WS_SEND',
      data: str,
      connectionGeneration: wsConnectionGeneration,
      authContextId: authContext.authContextId,
      serverOrigin: authContext.serverOrigin,
    });
    assertAuthenticatedContextCurrent(authContext, 'WebSocket send');
    return response?.success === true;
  } catch (error) {
    if (isAuthContextCancellation(error)) return false;
    console.warn('[WebSocket] Send deferred:', safeDiagnosticError(error));
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

const COMMAND_DIAGNOSTIC_MESSAGES = Object.freeze({
  AUTH_CONTEXT_INCOMPLETE: 'Command was canceled because authentication is incomplete.',
  AUTH_CONTEXT_SUPERSEDED: 'Command was canceled because the signed-in student changed.',
  STUDENT_BINDING_MISMATCH: 'Command was canceled because the student session changed.',
  COMMAND_ACK_AUTHORITY_UNAVAILABLE: 'Command was canceled because class authority is unavailable.',
  COMMAND_AUTHORITY_MISSING: 'Command is not authorized for the active class.',
  COMMAND_AUTHORITY_MISMATCH: 'Command is not authorized for the active class.',
  TAB_SNAPSHOT_REVISION_REQUIRED: 'The selected tab is no longer available.',
  STALE_TAB_SNAPSHOT: 'The selected tab is no longer available.',
  TAB_REF_NOT_FOUND: 'The selected tab is no longer available.',
  TAB_TARGET_REQUIRED: 'The selected tab is no longer available.',
  TAB_URL_NOT_FOUND: 'The selected tab is no longer available.',
  AMBIGUOUS_TAB_URL: 'The selected tab is no longer available.',
  TAB_CLOSE_FAILED: 'The selected tab could not be closed.',
  TAB_CLOSE_CAPABILITY_REQUIRED: 'A ClassPilot update is required for this action.',
  UNSUPPORTED_CLASSROOM_STATE_SCHEMA: 'This classroom command is not supported.',
  CLASSROOM_STATE_INVALID: 'The classroom command could not be applied.',
  COMMAND_FAILED: 'Command could not be completed.',
});
const COMMAND_DIAGNOSTIC_TEXT_ALLOWLIST = new Set([
  'Command belongs to an inactive supervision context',
  'Command belongs to an inactive teaching session',
  'Command has invalid school-policy authority',
  'Command is missing one immutable classroom authority',
  'Teacher message belongs to an inactive teaching session',
  'Teacher message belongs to a retired student session',
]);

function commandDiagnosticCode(error, fallback = 'COMMAND_FAILED') {
  const rawCode = typeof error?.code === 'string' ? error.code.trim() : '';
  if (Object.prototype.hasOwnProperty.call(COMMAND_DIAGNOSTIC_MESSAGES, rawCode)) return rawCode;
  return Object.prototype.hasOwnProperty.call(COMMAND_DIAGNOSTIC_MESSAGES, fallback)
    ? fallback
    : 'COMMAND_FAILED';
}

function commandErrorMessage(error) {
  const exactMessage = typeof error?.message === 'string' ? error.message.trim() : '';
  if (COMMAND_DIAGNOSTIC_TEXT_ALLOWLIST.has(exactMessage)) return exactMessage;
  return COMMAND_DIAGNOSTIC_MESSAGES[commandDiagnosticCode(error)];
}

function currentChromiumVersion() {
  const match = /(?:Chrome|Chromium)\/([0-9.]+)/.exec(globalThis.navigator?.userAgent || '');
  return match?.[1] || null;
}

function assertCommandAckAuthorityAvailable(authContext, reason = 'command acknowledgement') {
  const revision = currentStudentControlRevision();
  if (!hasNegotiatedCapability('exactBindingAckV2', authContext)) return revision;
  if (revision === null) {
    const error = new Error(`${reason} has no authoritative control revision`);
    error.code = 'COMMAND_ACK_AUTHORITY_UNAVAILABLE';
    throw error;
  }
  return revision;
}

async function sendCommandAck(commandId, ackState, options = {}) {
  const normalizedCommandId = normalizeCommandId(commandId);
  if (!normalizedCommandId) return false;
  const authContext = options.authContext || captureAuthenticatedContext('command acknowledgement');
  assertAuthenticatedContextCurrent(authContext, 'command acknowledgement');
  const binding = options.binding || {
    studentId: authContext.studentId,
    studentSessionId: authContext.studentSessionId,
  };
  // The command must identify the current student/session. When exact ACK V2
  // is active, enrich the outbound ACK from the already captured immutable
  // authentication context instead of demanding that unrelated legacy command
  // envelopes carry ACK-only school/device/control fields.
  assertBindingMatchesAuthContext(binding, authContext, 'command acknowledgement', {
    requireFullAuthority: false,
  });
  const exactAckNegotiated = hasNegotiatedCapability('exactBindingAckV2', authContext);
  const preserveExactTabRevision = (
    hasNegotiatedCapability('exactTabCloseV2', authContext)
    && (options.commandType === 'close-tab' || options.commandType === 'close-tabs')
    && binding.bindingVersion === 2
  );
  if (preserveExactTabRevision && (
    binding.bindingVersion !== 2
    || binding.schoolId !== authContext.schoolId
    || binding.deviceId !== authContext.deviceId
    || !Number.isSafeInteger(binding.controlRevision)
  )) {
    const error = new Error('Exact tab acknowledgement does not match its captured authority tuple');
    error.code = 'STUDENT_BINDING_MISMATCH';
    throw error;
  }
  if (exactAckNegotiated && !preserveExactTabRevision && currentStudentControlRevision() === null) {
    // Exact ACK V2 scopes acknowledgement creation only. An ordinary command
    // that already passed its student/session and classroom-authority checks
    // remains executable while the control-revision watermark is hydrating;
    // no under-bound ACK is created in that interval.
    return false;
  }
  const ackControlRevision = preserveExactTabRevision
    ? binding.controlRevision
    : exactAckNegotiated
      ? assertCommandAckAuthorityAvailable(authContext)
      : currentStudentControlRevision();
  const ackBinding = exactAckNegotiated ? {
    bindingVersion: 2,
    schoolId: authContext.schoolId,
    deviceId: authContext.deviceId,
    studentId: authContext.studentId,
    studentSessionId: authContext.studentSessionId,
    controlRevision: ackControlRevision,
  } : binding;

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
    commandType: safeDiagnosticLabel(options.commandType),
    bindingVersion: 2,
    authContextId: authContext.authContextId,
    schoolId: authContext.schoolId || undefined,
    studentId: ackBinding.studentId,
    studentSessionId: ackBinding.studentSessionId,
    deviceId: authContext.deviceId,
    studentControlRevision: ackBinding.controlRevision ?? ackControlRevision ?? undefined,
    result: options.result,
    state: options.state,
    error: options.error,
    errorCode: options.errorCode,
    deliveryPolicy: options.deliveryPolicy,
    expiresAt: options.expiresAt,
    appliedRevision: options.appliedRevision ?? currentClassroomState?.revision ?? 0,
    outcome: options.outcome || defaultOutcome,
    extensionVersion: chrome.runtime.getManifest().version,
    timestamp: new Date().toISOString(),
  };

  await enqueueCommandAck(ack, authContext);
  assertAuthenticatedContextCurrent(authContext, 'command acknowledgement');
  await wsSend(ack, authContext);
  scheduleCommandAckFlush();
  return true;
}
let cameraActive = false; // Aggregate current-authority camera usage across tabs
const cameraActiveTabs = new Set();

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
const SCHOOL_SETTINGS_SCOPE_KEY = 'schoolSettingsScopeV1';
const GLOBAL_BLOCKED_DOMAINS_SCOPE_KEY = 'globalBlockedDomainsScopeV1';
const SETTINGS_FETCH_INTERVAL_MS = 60 * 60 * 1000;
const IDLE_DETECTION_SECONDS = 180;
// The in-memory interval is the only steady-state heartbeat cadence. Chrome's
// recurring alarm exists solely to recover after MV3 suspends the worker and
// therefore must not create two additional heartbeats per minute while the
// interval is healthy.
const HEARTBEAT_INTERVAL_MS = 10000;
const HEARTBEAT_RECOVERY_STALE_MS = HEARTBEAT_INTERVAL_MS * 2;
const HEARTBEAT_REQUEST_TIMEOUT_MS = 15 * 1000;
const HEARTBEAT_ACTIVE_MINUTES = 0.5;
const HEARTBEAT_IDLE_MINUTES = 0.5;
const NAVIGATION_DEBOUNCE_MS = 50;      // Reduced from 350ms for near-instant tracking
const EVENT_HEARTBEAT_COALESCE_MS = 2000;
const LICENSE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const LICENSE_CHECK_ALARM = 'license-check';
const LICENSE_STATUS_RETRY_ALARM = 'license-status-retry';
const LICENSE_STATUS_RETRY_DELAYS_MS = Object.freeze([2000, 5000, 15000, 30000, 60000]);
const LICENSE_STATUS_REQUEST_TIMEOUT_MS = 5000;
const LICENSE_CONTROL_CLEANUP_ALARM = 'license-control-cleanup';
const LICENSE_CONTROL_CLEANUP_RETRY_MS = 15 * 1000;
const LICENSE_STATE_SCOPE_KEY = 'licenseStateScopeV1';
const LICENSE_LAST_VERIFIED_AT_KEY = 'licenseLastVerifiedAtV1';
const MANUAL_LOGIN_STALE_MS = 5 * 60 * 1000;
// Permit only sub-second scheduling/serialization skew. A larger future value
// usually means the Chromebook clock moved backwards and must not extend a
// shared-device login indefinitely.
const MANUAL_LOGIN_FUTURE_SKEW_MS = 1000;
const SHARED_AUTH_LOCK_TIMEOUT_MS = MANUAL_LOGIN_STALE_MS;
const SHARED_AUTH_LOCK_ALARM_NAME = 'shared-auth-lock-timeout';
const SHARED_AUTH_LOCK_OWNER_KEY = 'sharedAuthLockOwnerV1';
const SHARED_SIGN_IN_CONFIG_FETCH_INTERVAL_MS = 5 * 60 * 1000;
const SHARED_SIGN_IN_CONFIG_CACHE_KEY = 'sharedSignInConfigCacheV1';
const MANAGED_AUTH_GATE_BINDING_KEY = 'managedAuthGateBindingV1';
const SHARED_SIGN_IN_CONFIG_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SHARED_SIGN_IN_CONFIG_RETRY_ALARM = 'shared-sign-in-config-retry';
const SHARED_SIGN_IN_CONFIG_RETRY_DELAYS_MS = Object.freeze([2000, 5000, 15000, 30000]);
const AUTH_GATE_REQUEST_TIMEOUT_MS = 5000;
const STUDENT_AUTH_GATE_PRESENCE_REQUEST_TIMEOUT_MS = 5000;
const STUDENT_AUTH_GATE_PRESENCE_SOURCE_TTL_MS = 30 * 1000;
const STUDENT_AUTH_GATE_PRESENCE_MIN_PUBLISH_MS = 8 * 1000;
const STUDENT_AUTH_GATE_PRESENCE_RETRY_MS = 10 * 1000;
const STUDENT_AUTH_GATE_PRESENCE_UNAVAILABLE_RETRY_MS = 30 * 1000;
const STUDENT_AUTH_GATE_PRESENCE_UNNEGOTIATED_RETRY_MS = 60 * 1000;
const SIGN_OUT_REQUEST_TIMEOUT_MS = 2000;
const STUDENT_SESSION_RECOVERY_STORAGE_KEY = 'studentSessionRecoveryV1';
const STUDENT_SESSION_RECOVERY_ALARM = 'student-session-recovery';
const STUDENT_SESSION_RECOVERY_SCHEMA_VERSION = 1;
const STUDENT_SESSION_RECOVERY_MAX_PENDING = 8;
const STUDENT_SESSION_RECOVERY_PENDING_TTL_MS = 15 * 60 * 1000;
const STUDENT_SESSION_RECOVERY_REQUEST_TIMEOUT_MS = 2000;
const STUDENT_SESSION_RECOVERY_RETRY_DELAYS_MS = Object.freeze([
  5000,
  30 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
]);
const STUDENT_SESSION_RECOVERY_INTENT_RESUME = 'resume';
const STUDENT_SESSION_RECOVERY_INTENT_RELEASE = 'release';
const MANAGED_DEVICE_CONTINUITY_SESSION_KEY = 'managedDeviceContinuityV1';
const MANAGED_DEVICE_CONTINUITY_CAPABILITIES = Object.freeze([
  'scopedAuthorityChecksV1',
  'kioskLaunchTicketV2',
  'managedDeviceContinuityV1',
]);
const STUDENT_AUTH_GATE_PRESENCE_CAPABILITIES = Object.freeze([
  'scopedAuthorityChecksV1',
  'studentAuthGatePresenceV1',
  'lateSignInRestrictionSsoV1',
]);
const RESTRICTION_SSO_VISIT_STORAGE_KEY = 'restrictionSsoVisitStateV1';
const RESTRICTION_SSO_VISIT_SCHEMA_VERSION = 1;
const MANAGED_DEVICE_CONTINUITY_MAX_PROOF_TTL_MS = 10 * 60 * 1000;
const MANAGED_DEVICE_CONTINUITY_EXPIRY_SKEW_MS = 5000;
const LOGIN_ROSTER_CACHE_MIN_AGE_MS = 5000;
const LOGIN_ROSTER_REFRESH_MIN_MS = 25 * 1000;
const LOGIN_ROSTER_REFRESH_MAX_MS = 35 * 1000;
const LOGIN_ROSTER_BACKOFF_MAX_MS = 5 * 60 * 1000;
const AUTH_GATE_TIMING_STORAGE_KEY = 'authGateTimingV1';
const AUTH_GATE_REVISION_STORAGE_KEY = 'authGateRevisionV1';
const AUTH_GATE_ROSTER_CONTEXT_STORAGE_KEY = 'authGateRosterContextV1';
const AUTH_GATE_ROSTER_CONTEXT_SCHEMA_VERSION = 1;
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
const PENDING_CHECK_IN_KEY = 'pendingCheckIn';
const PENDING_CHECK_IN_EXPIRY_ALARM = 'pending-check-in-expiry';
const PENDING_CHECK_IN_MAX_AGE_MS = 5 * 60 * 1000;
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
let schoolSettingsScope = null;
let schoolSettingsMutation = Promise.resolve();
const MONITORING_STATE_STORAGE_KEY = 'monitoringStateV1';
const MONITORING_STATE_SCOPE_KEY = 'monitoringStateScopeV1';
let persistedMonitoringState = {
  state: TRACKING_STATES.OFF,
  changedAt: Date.now(),
  reason: 'worker_default',
};
let persistedMonitoringStateScope = null;

let connectivityHealth = RuntimeCore.emptyConnectivityHealth();
let screenshotHealth = RuntimeCore.emptyScreenshotHealth();
let lastConnectivityHealthPersistAt = 0;
let lastConnectivityPersistedState = 'checking';
let screenshotPolicyState = Object.freeze({
  mode: 'pending',
  observed: false,
  captureAllowed: false,
  expiresAt: 0,
  scope: null,
  authority: null,
  authorityScope: null,
  captureCadence: Object.freeze({
    mode: 'background',
    intervalSeconds: 30,
    expiresAt: 0,
  }),
  valid: false,
});
let screenshotPolicyGeneration = 0;
let screenshotPolicyAbortController = new AbortController();
let screenshotImmediateCapturePending = false;
let screenshotCadenceGeneration = 0;
let screenshotCadenceIssuedAt = 0;
let activeScreenshotCadence = null;
let screenshotNavigationDebounceTimer = null;
let protocolPolicyRequestGeneration = 0;
let protocolPolicyAppliedGeneration = 0;
let screenshotPolicyRequestGeneration = 0;
let screenshotPolicyAppliedGeneration = 0;
let screenshotPolicySource = 'pending';
let screenshotPolicyAdoptedAt = 0;

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
let lastKnownTabsAuthBinding = null;
const TAB_SNAPSHOT_STORAGE_KEY = 'tabSnapshotV1';
let tabSnapshotMutation = Promise.resolve();
let currentTabSnapshotRevision = 0;
let settingsAlarmScheduled = false;
let heartbeatIntervalId = null;
let observedByTeacher = false;
let eventHeartbeatTimer = null;
let eventHeartbeatReason = null;
// Entitlement is pending/fail-private until the current exact authentication
// context receives an authoritative school-status response. Never inherit a
// previous student's or school's boolean across an authority transition.
let licenseActive = false;
let licenseStateScope = null;
let licensePlanStatus = null;
let licenseLastVerifiedAt = 0;
let licenseRefreshState = 'unknown';
let licenseStatusRetryAttempt = 0;
let licenseStatusRequestInFlight = null;
let licenseStatusRequestScope = null;
let offHoursNetworkPaused = false;
let registrationRetryCount = 0;
const MAX_REGISTRATION_RETRIES = 5;
let apiBackoffUntilMs = 0;
let heartbeatInFlight = false;
let lastHeartbeatDispatchAt = 0;
let screenshotCaptureInFlight = false;
let currentFabState = null;
let studentControlRevisionAuthority = Object.freeze({
  scope: null,
  revision: null,
});
const activeAuthBoundNotificationIds = new Set();
let authBoundNotificationCleanupPromise = Promise.resolve(false);
let authBoundNotificationInventoryReconciled = false;
let authBoundNotificationCleanupInFlight = null;
let authBoundNotificationCleanupRetryAt = 0;
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
let authGateRosterContextGeneration = 0;
let authGateRosterContextFingerprint = null;
let authGateRosterContextReady = false;
let resolveAuthGateRosterContextReady;
let rejectAuthGateRosterContextReady;
const authGateRosterContextReadyPromise = new Promise((resolve, reject) => {
  resolveAuthGateRosterContextReady = resolve;
  rejectAuthGateRosterContextReady = reject;
});
authGateRosterContextReadyPromise.catch(() => {});
let authGateRosterContextMutationTail = Promise.resolve();
let managedAuthGateSetupUnavailable = false;
let managedAuthGatePolicyRestorePromise = Promise.resolve({});
let managedAuthGateDirectRevalidationInFlight = null;
let authoritativeManagedSchoolPolicyScope = null;
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
let managedKioskDirectoryProbeInFlight = null;
let studentSessionRecoveryState = Object.freeze({
  schemaVersion: STUDENT_SESSION_RECOVERY_SCHEMA_VERSION,
  armed: null,
  pending: Object.freeze([]),
});
let studentSessionRecoveryLoadPromise = null;
let studentSessionRecoveryLoaded = false;
let studentSessionRecoveryMutationTail = Promise.resolve();
let studentSessionRecoveryFlushPromise = null;
let studentSessionRecoveryRevision = 0;
let managedDeviceContinuityState = null;
let managedDeviceContinuityLoaded = false;
let managedDeviceContinuityLoadPromise = null;
let managedDeviceContinuityIssuancePromise = null;
let managedDeviceContinuityRevision = 0;
const loginRosterRecoveryGrants = new Map();
const loginRosterCache = new Map();
const loginRosterInFlight = new Map();
const loginRosterBackoffUntil = new Map();
const studentAuthGatePresenceSources = new Map();
let studentAuthGatePresencePublishInFlight = null;
let studentAuthGatePresenceAbortController = null;
let studentAuthGatePresenceLastDispatchAt = 0;
let studentAuthGatePresenceRetryAt = 0;
let studentAuthGatePresenceRetryContext = null;
let legacyStudentAuthCleanupAuthority = null;
let legacyStudentAuthCleanupPromise = null;

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

function normalizedAuthGateRosterContextState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const generation = Number(raw.generation);
  const fingerprint = String(raw.fingerprint || '').trim().toLowerCase();
  if (
    raw.schemaVersion !== AUTH_GATE_ROSTER_CONTEXT_SCHEMA_VERSION
    || !Number.isSafeInteger(generation)
    || generation < 1
    || !/^[0-9a-f]{64}$/.test(fingerprint)
  ) return null;
  return { generation, fingerprint };
}

function authGateRosterContextMaterial() {
  const binding = authGateConfigBinding();
  return JSON.stringify([
    binding.serverOrigin || '',
    binding.schoolId || '',
    binding.schoolSlug || '',
    String(CONFIG.enrollmentKey || ''),
    fastAuthGateEnabled === true,
    hasManagedSchoolSetup(),
    sharedSignInLoginConfig.sharedSignInEnabled === true,
    sharedSignInLoginConfig.loginMethod === 'email_id' ? 'email_id' : 'name_pin',
    sharedSignInLoginConfig.pinLoginEnabled === true,
    String(sharedSignInLoginConfig.schoolId || ''),
  ]);
}

async function authGateRosterContextFingerprintForCurrentMaterial() {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(authGateRosterContextMaterial()),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function reconcileAuthGateRosterContext(storedState) {
  const prior = storedState === undefined
    ? normalizedAuthGateRosterContextState({
      schemaVersion: AUTH_GATE_ROSTER_CONTEXT_SCHEMA_VERSION,
      generation: authGateRosterContextGeneration,
      fingerprint: authGateRosterContextFingerprint,
    })
    : normalizedAuthGateRosterContextState(storedState);
  const fingerprint = await authGateRosterContextFingerprintForCurrentMaterial();
  const unchanged = prior?.fingerprint === fingerprint;
  const generation = unchanged
    ? prior.generation
    : prior
      ? prior.generation + 1
      : Math.max(1, Date.now());
  if (!Number.isSafeInteger(generation)) {
    throw new Error('Auth gate roster context generation space exhausted');
  }
  if (!unchanged) {
    await durableLocalKv.set({
      [AUTH_GATE_ROSTER_CONTEXT_STORAGE_KEY]: {
        schemaVersion: AUTH_GATE_ROSTER_CONTEXT_SCHEMA_VERSION,
        generation,
        fingerprint,
      },
    });
  }
  authGateRosterContextGeneration = generation;
  authGateRosterContextFingerprint = fingerprint;
  if (!authGateRosterContextReady) {
    authGateRosterContextReady = true;
    resolveAuthGateRosterContextReady(generation);
  }
  return generation;
}

function scheduleAuthGateRosterContextReconcile() {
  const run = authGateRosterContextMutationTail
    .catch(() => {})
    .then(async () => {
      await authGateRosterContextReadyPromise;
      return reconcileAuthGateRosterContext();
    });
  authGateRosterContextMutationTail = run;
  run.catch(() => {});
  return run;
}

async function awaitAuthGateRosterContextStable() {
  await authGateRosterContextReadyPromise;
  while (true) {
    const pending = authGateRosterContextMutationTail;
    await pending;
    if (pending === authGateRosterContextMutationTail) return;
  }
}

function currentAuthGateRosterContextGeneration() {
  return authGateRosterContextReady ? authGateRosterContextGeneration : 0;
}

function advanceManagedAuthGatePolicyGeneration() {
  managedAuthGatePolicyGeneration += 1;
  return managedAuthGatePolicyGeneration;
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
  scheduleAuthGateRosterContextReconcile().catch(() => {});
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
  resetLoginRosterRuntimeCache();
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
    if (typeof options.beforeAttempt === 'function') {
      await options.beforeAttempt(attempt);
    }
    if (init.signal?.aborted) {
      throw authContextSuperseded(context);
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
      if (init.signal?.aborted || error?.name === 'AbortError') {
        throw authContextSuperseded(context);
      }
      if (attempt >= maxAttempts) {
        throw error;
      }
      console.warn(`[Network] ${context} failed; retrying (${attempt}/${maxAttempts})`, safeDiagnosticError(error));
      await sleepMs(calculateRetryDelayMs(null, attempt));
    }
  }

  throw new Error(`${context} failed`);
}

function scheduleHealthCheckAlarm(periodInMinutes = hasStudentAuth() ? 1 : 5) {
  const normalizedPeriod = Math.max(1, Number(periodInMinutes) || 5);
  chrome.alarms.get(HEALTH_CHECK_ALARM_NAME, (existing) => {
    if (existing && Number(existing.periodInMinutes) === normalizedPeriod) return;
    chrome.alarms.create(HEALTH_CHECK_ALARM_NAME, { periodInMinutes: normalizedPeriod });
  });
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
let offscreenCloseInFlight = null;
let offscreenReady = false;
let activeLiveViewNegotiationId = null;
let activeLiveViewTeachingSessionId = null;
let activeLiveViewContext = null;
let liveViewStartGeneration = 0;
let liveViewSeenNegotiationScope = null;
let liveViewSeenNegotiationIds = new Set();
let liveViewTelemetryAttempts = new Set();

// Storage helpers. Exact student-bound runtime state survives MV3 worker
// suspension in storage.session, but disappears on a browser restart/update
// together with the authenticated student authority it belongs to.
const SESSION_SCOPED_STUDENT_STORAGE_KEYS = new Set([
  'authContextId',
  'studentToken',
  'activeStudentId',
  'activeStudentSessionId',
  'studentEmail',
  'studentName',
  'registered',
  'lastRegisteredEmail',
  'identitySource',
  'manualLoginLastSeenAt',
  'sharedAuthLockedSinceAt',
  'sharedAuthLockOwnerV1',
  'classroomStateStudentBindingV1',
  'licenseStateScopeV1',
  'licenseLastVerifiedAtV1',
  'monitoringStateScopeV1',
  'messages',
  'messageInboxAuthBindingV1',
  'messageInboxSeenIdsV1',
  'pendingCheckIn',
  'fabStateV1',
  'fabContextV1',
  'fabChatContextV1',
  'classroomOverlayStateV1',
  'handRaised',
  'messagingEnabled',
  'handRaisingEnabled',
  'fabChatMessages',
  'fabChatClosed',
  'tabSnapshotV1',
  'monitoringEventOutboxV1',
  'monitoringEventOutboxDropped',
  'monitoringEventOutboxAuthBindingV1',
  'commandAckOutboxV1',
  'commandAckOutboxAuthBindingV1',
  'chatAckOutboxV1',
  'chatAckOutboxAuthBindingV1',
  'studentChatOutboxV1',
  'studentChatOutboxAuthBindingV1',
]);

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

function storageRequestKeys(keys) {
  if (keys === null || keys === undefined) return null;
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) return keys;
  if (typeof keys === 'object') return Object.keys(keys);
  return [];
}

function routedStudentStorageArea(localArea, sessionArea) {
  return {
    async get(keys) {
      const requested = storageRequestKeys(keys);
      const sensitiveKeys = requested === null
        ? [...SESSION_SCOPED_STUDENT_STORAGE_KEYS]
        : requested.filter((key) => SESSION_SCOPED_STUDENT_STORAGE_KEYS.has(key));
      const [local, legacyLocalSensitive, session] = await Promise.all([
        localArea.get(keys),
        sensitiveKeys.length > 0 ? localArea.get(sensitiveKeys) : Promise.resolve({}),
        sensitiveKeys.length > 0 && sessionArea
          ? sessionArea.get(sensitiveKeys)
          : Promise.resolve({}),
      ]);
      const merged = { ...local };
      for (const key of sensitiveKeys) delete merged[key];
      for (const key of sensitiveKeys) {
        if (Object.prototype.hasOwnProperty.call(session, key)) merged[key] = session[key];
      }
      const staleKeys = Object.keys(legacyLocalSensitive)
        .filter((key) => SESSION_SCOPED_STUDENT_STORAGE_KEYS.has(key));
      let capturedLegacyCleanup = false;
      if (staleKeys.includes('studentToken')) {
        const cleanupContext = await localArea.get(['config', 'deviceId']);
        capturedLegacyCleanup = captureLegacyStudentAuthCleanupAuthority({
          ...cleanupContext,
          ...legacyLocalSensitive,
        });
      }
      if (staleKeys.length > 0) await localArea.remove(staleKeys);
      // Start one best-effort cleanup when a late legacy record is found, but
      // do not make unrelated routed storage reads retry or wait on network
      // recovery. The auth restore and login-roster gates below own the
      // correlated retry barrier.
      if (capturedLegacyCleanup) {
        dispatchLegacyStudentAuthCleanup().catch(() => {});
      }
      return merged;
    },
    async set(obj) {
      const localValues = {};
      const sessionValues = {};
      for (const [key, value] of Object.entries(obj || {})) {
        if (SESSION_SCOPED_STUDENT_STORAGE_KEYS.has(key)) sessionValues[key] = value;
        else localValues[key] = value;
      }
      const sessionKeys = Object.keys(sessionValues);
      if (sessionKeys.length > 0 && !sessionArea) {
        throw new Error('Secure student session storage is unavailable');
      }
      if (sessionKeys.length > 0) await sessionArea.set(sessionValues);
      if (Object.keys(localValues).length > 0) await localArea.set(localValues);
      if (sessionKeys.length > 0) await localArea.remove(sessionKeys);
    },
    async remove(keys) {
      const requested = storageRequestKeys(keys) || [...SESSION_SCOPED_STUDENT_STORAGE_KEYS];
      const sensitiveKeys = requested.filter(
        (key) => SESSION_SCOPED_STUDENT_STORAGE_KEYS.has(key),
      );
      await localArea.remove(keys);
      if (sensitiveKeys.length > 0 && sessionArea) await sessionArea.remove(sensitiveKeys);
    },
  };
}

const rawLocalKv = strictStorageArea(chrome.storage.local, 'local storage');
const rawSessionKv = hasSessionStorage()
  ? strictStorageArea(chrome.storage.session, 'session storage')
  : null;
const kv = routedStudentStorageArea(rawLocalKv, rawSessionKv);
const durableLocalKv = routedStudentStorageArea(rawLocalKv, rawSessionKv);

function connectivityStatus(nowValue = Date.now(), options = {}) {
  if (!currentLicenseIsActive()) {
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
  const existing = await chrome.alarms.get(CONNECTIVITY_HEALTH_ALARM_NAME);
  if (trackingState === TRACKING_STATES.OFF || !hasStudentAuth() || !currentLicenseIsActive()) {
    if (existing) await chrome.alarms.clear(CONNECTIVITY_HEALTH_ALARM_NAME);
    return;
  }
  const { boundaryAt } = RuntimeCore.connectivityHealthState(connectivityHealth, nowValue);
  if (!boundaryAt) {
    if (existing) await chrome.alarms.clear(CONNECTIVITY_HEALTH_ALARM_NAME);
    return;
  }
  if (boundaryAt <= nowValue) {
    await setConnectivityBadge(connectivityStatus(nowValue));
    return;
  }
  if (existing && Math.abs(Number(existing.scheduledTime || 0) - boundaryAt) < 1000) return;
  chrome.alarms.create(CONNECTIVITY_HEALTH_ALARM_NAME, { when: boundaryAt });
}

function safeDiagnosticError(error) {
  const code = typeof error?.code === 'string' ? error.code.trim() : '';
  if (DIAGNOSTIC_CODE_ALLOWLIST.has(code)) return code;
  const name = typeof error?.name === 'string' ? error.name.trim() : '';
  if (SENTRY_EXCEPTION_TYPE_ALLOWLIST.has(name)) return name;
  return 'Error';
}

const DIAGNOSTIC_LABEL_ALLOWLIST = new Set([
  'ANSWER',
  'CAPTURE_ERROR',
  'CONNECTION_FAILED',
  'ICE_CANDIDATE',
  'ICE_RESTART_REQUIRED',
  'LIVE_VIEW_ATTEMPT_TERMINAL',
  'LIVE_VIEW_EXPIRED',
  'OFFSCREEN_READY',
  'WS_EVENT',
  'apply-block-list',
  'apply-flight-path',
  'attention-mode',
  'auth-error',
  'auth-failed',
  'auth-success',
  'auto',
  'broadcast-ice',
  'broadcast-offer',
  'chat',
  'chat-closed',
  'chat-message-ack-receipt',
  'chat-notification',
  'close',
  'close-tab',
  'close-tabs',
  'command-ack-receipt',
  'end',
  'fab-state',
  'fab-state-sync',
  'hand-dismissed',
  'hand-raising-toggle',
  'ice',
  'limit-tabs',
  'lock-screen',
  'messaging-toggle',
  'offer',
  'open',
  'open-tab',
  'pause',
  'ping',
  'poll',
  'remote-control',
  'remove-block-list',
  'remove-flight-path',
  'request-stream',
  'resume',
  'screen',
  'session-ended',
  'start',
  'stop',
  'stop-share',
  'student-session-ended',
  'student-session-replaced',
  'student-sign-out',
  'tab',
  'teacher-message',
  'temp-unblock',
  'timer',
  'unlock-screen',
  'update-global-blacklist',
]);

function safeDiagnosticLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  return DIAGNOSTIC_LABEL_ALLOWLIST.has(label) ? label : 'unknown';
}

function warnAuthCleanupFailure(label, error) {
  console.warn(label, safeDiagnosticError(error));
}

async function persistConnectivityHealthIfNeeded(priorState, nowValue, authContext = null) {
  if (authContext) assertAuthenticatedContextCurrent(authContext, 'connectivity health persistence');
  const nextState = RuntimeCore.connectivityHealthState(connectivityHealth, nowValue).state;
  if (priorState !== nextState
    || lastConnectivityPersistedState !== nextState
    || nowValue - lastConnectivityHealthPersistAt >= 60 * 1000) {
    if (authContext) assertAuthenticatedContextCurrent(authContext, 'connectivity health persistence');
    await kv.set({ [CONNECTIVITY_HEALTH_STORAGE_KEY]: connectivityHealth });
    if (authContext) assertAuthenticatedContextCurrent(authContext, 'connectivity health persistence');
    lastConnectivityPersistedState = nextState;
    lastConnectivityHealthPersistAt = nowValue;
  }
  return nextState;
}

async function recordHeartbeatSuccess(nowValue = Date.now(), authContext = null) {
  if (authContext) assertAuthenticatedContextCurrent(authContext, 'heartbeat health success');
  const prior = RuntimeCore.connectivityHealthState(connectivityHealth, nowValue);
  const recovered = connectivityHealth.consecutiveFailures > 0 || prior.state === 'unreachable';
  apiBackoffUntilMs = 0;
  connectivityHealth = RuntimeCore.connectivityHealthAfterSuccess(connectivityHealth, nowValue);
  await persistConnectivityHealthIfNeeded(prior.state, nowValue, authContext);
  if (authContext) assertAuthenticatedContextCurrent(authContext, 'heartbeat health success');
  await setConnectivityBadge(connectivityStatus(nowValue));
  if (authContext) assertAuthenticatedContextCurrent(authContext, 'heartbeat health success');
  await scheduleConnectivityHealthBoundary(nowValue);
  if (authContext) assertAuthenticatedContextCurrent(authContext, 'heartbeat health success');

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

async function recordHeartbeatFailure(errorCategory, nowValue = Date.now(), authContext = null) {
  if (authContext) assertAuthenticatedContextCurrent(authContext, 'heartbeat health failure');
  const priorState = RuntimeCore.connectivityHealthState(connectivityHealth, nowValue).state;
  connectivityHealth = RuntimeCore.connectivityHealthAfterFailure(
    connectivityHealth,
    errorCategory,
    nowValue
  );
  await persistConnectivityHealthIfNeeded(priorState, nowValue, authContext);
  if (authContext) assertAuthenticatedContextCurrent(authContext, 'heartbeat health failure');
  await setConnectivityBadge(connectivityStatus(nowValue));
  if (authContext) assertAuthenticatedContextCurrent(authContext, 'heartbeat health failure');
  await scheduleConnectivityHealthBoundary(nowValue);
  if (authContext) assertAuthenticatedContextCurrent(authContext, 'heartbeat health failure');
  return connectivityHealth;
}

function syncScreenshotHealthGlobals() {
  lastScreenshotAttemptAt = screenshotHealth.lastAttemptAt || 0;
  lastScreenshotSuccessAt = screenshotHealth.lastSuccessAt || 0;
  lastScreenshotErrorAt = screenshotHealth.lastErrorAt || 0;
  lastScreenshotError = screenshotHealth.lastErrorCode || '';
}

async function persistScreenshotHealth(nextHealth, authContext = null) {
  if (authContext) assertAuthenticatedContextCurrent(authContext, 'screenshot health persistence');
  const normalized = RuntimeCore.normalizeScreenshotHealth(nextHealth);
  if (authContext) assertAuthenticatedContextCurrent(authContext, 'screenshot health persistence');
  await kv.set({ [SCREENSHOT_HEALTH_STORAGE_KEY]: normalized });
  if (authContext) assertAuthenticatedContextCurrent(authContext, 'screenshot health persistence');
  screenshotHealth = normalized;
  syncScreenshotHealthGlobals();
  return screenshotHealth;
}

async function recordScreenshotAttempt(nowValue = Date.now(), authContext = null) {
  return persistScreenshotHealth({
    ...screenshotHealth,
    schemaVersion: RuntimeCore.SCREENSHOT_HEALTH_SCHEMA_VERSION,
    lastAttemptAt: nowValue,
  }, authContext);
}

async function recordScreenshotError(errorCode, nowValue = Date.now(), authContext = null) {
  return persistScreenshotHealth({
    ...screenshotHealth,
    schemaVersion: RuntimeCore.SCREENSHOT_HEALTH_SCHEMA_VERSION,
    lastErrorAt: nowValue,
    lastErrorCode: errorCode,
  }, authContext);
}

async function recordScreenshotSuccess(nowValue = Date.now(), authContext = null) {
  return persistScreenshotHealth({
    ...screenshotHealth,
    schemaVersion: RuntimeCore.SCREENSHOT_HEALTH_SCHEMA_VERSION,
    lastSuccessAt: nowValue,
  }, authContext);
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
  'authContextId',
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
  SHARED_AUTH_LOCK_OWNER_KEY,
];
const SESSION_ONLY_STUDENT_AUTH_KEYS = Object.freeze([
  'authContextId',
  'studentToken',
  'activeStudentId',
  'activeStudentSessionId',
  'studentEmail',
  'studentName',
  'registered',
  'lastRegisteredEmail',
  'identitySource',
  'manualLoginLastSeenAt',
  'sharedAuthLockedSinceAt',
  SHARED_AUTH_LOCK_OWNER_KEY,
  'classroomStateStudentBindingV1',
]);

function persistedNonAuthConfig(raw = {}) {
  return Object.fromEntries(PERSISTED_CONFIG_KEYS.flatMap((key) => (
    Object.prototype.hasOwnProperty.call(raw, key) ? [[key, raw[key]]] : []
  )));
}

function hasSessionStorage() {
  return Boolean(chrome.storage?.session);
}

const durableSessionKv = rawSessionKv;

function captureLegacyStudentAuthCleanupAuthority(local = {}) {
  if (legacyStudentAuthCleanupAuthority) return false;
  const token = typeof local.studentToken === 'string'
    && local.studentToken.length > 0
    && local.studentToken.length <= 16 * 1024
    ? local.studentToken
    : null;
  const serverOrigin = normalizedServerOrigin(local.config?.serverUrl || CONFIG.serverUrl);
  const deviceId = String(local.deviceId || local.config?.deviceId || '').trim() || null;
  if (!token || !serverOrigin || !deviceId) return false;
  // The upgrade bridge is intentionally memory-only. It is never used to
  // restore UI/auth authority and is consumed by one bounded sign-out attempt.
  legacyStudentAuthCleanupAuthority = Object.freeze({ token, serverOrigin, deviceId });
  return true;
}

function dispatchLegacyStudentAuthCleanup() {
  if (legacyStudentAuthCleanupPromise) return legacyStudentAuthCleanupPromise;
  const authority = legacyStudentAuthCleanupAuthority;
  if (!authority) return Promise.resolve(true);

  // Pre-2.7.3 builds could leave a reusable bearer in storage.local without a
  // durable recovery capability. The local copy is purged before this runs,
  // but the captured memory-only authority must remain alive until the exact
  // server session end is confirmed. Otherwise an extension-update worker can
  // terminate after opening the gate and strand the student for the complete
  // five-minute manual-session lease.
  const run = notifyBackendOfStudentSignOut(authority, 'legacy_local_auth_upgrade')
    .then((confirmed) => {
      if (confirmed && legacyStudentAuthCleanupAuthority === authority) {
        legacyStudentAuthCleanupAuthority = null;
      }
      return confirmed;
    })
    .finally(() => {
      if (legacyStudentAuthCleanupPromise === run) {
        legacyStudentAuthCleanupPromise = null;
      }
    });
  legacyStudentAuthCleanupPromise = run;
  return run;
}

async function getStoredAuthState(keys) {
  const local = await rawLocalKv.get(keys);
  const session = hasSessionStorage() ? await durableSessionKv.get(keys) : {};
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
  // Releases before 2.7.3 could persist student identity and reusable bearer
  // material in local storage. Never adopt that legacy copy as authority.
  // Purge it on the first read and use only storage.session for these fields.
  const requestedKeys = Array.isArray(keys) ? new Set(keys) : null;
  const legacyLocalAuthKeys = [...SESSION_SCOPED_STUDENT_STORAGE_KEYS].filter((key) => (
    (!requestedKeys || requestedKeys.has(key))
    && Object.prototype.hasOwnProperty.call(local, key)
  ));
  let capturedLegacyCleanup = false;
  if (legacyLocalAuthKeys.includes('studentToken')) {
    let cleanupSource = local;
    if (!local.config || !local.deviceId) {
      cleanupSource = {
        ...(await rawLocalKv.get(['config', 'deviceId'])),
        ...local,
      };
    }
    capturedLegacyCleanup = captureLegacyStudentAuthCleanupAuthority(cleanupSource);
  }
  for (const key of SESSION_SCOPED_STUDENT_STORAGE_KEYS) {
    if (requestedKeys && !requestedKeys.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(session, key)) merged[key] = session[key];
    else delete merged[key];
  }
  if (legacyLocalAuthKeys.length > 0) {
    await rawLocalKv.remove(legacyLocalAuthKeys);
  }
  if (
    capturedLegacyCleanup
    || legacyStudentAuthCleanupAuthority
    || legacyStudentAuthCleanupPromise
  ) {
    await dispatchLegacyStudentAuthCleanup();
  }
  return merged;
}

async function setManualAuthState(obj) {
  if (!hasSessionStorage()) {
    throw new Error('Secure student session storage is unavailable');
  }
  await durableSessionKv.set(obj);
  await rawLocalKv.remove(Object.keys(obj));
}

async function clearStoredAuthState(localOverrides = {}) {
  const stored = await durableLocalKv.get(['config']);
  const durableControls = {};
  if (Object.prototype.hasOwnProperty.call(localOverrides, 'autoRegistrationPaused')) {
    durableControls.autoRegistrationPaused = localOverrides.autoRegistrationPaused === true;
  }
  await durableLocalKv.set({
    config: persistedNonAuthConfig(stored.config || CONFIG),
    ...durableControls,
  });
  await durableLocalKv.remove(SESSION_ONLY_STUDENT_AUTH_KEYS);
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

function emptyStudentSessionRecoveryState() {
  return {
    schemaVersion: STUDENT_SESSION_RECOVERY_SCHEMA_VERSION,
    armed: null,
    pending: [],
  };
}

function resetLoginRosterRuntimeCache() {
  loginRosterCache.clear();
  loginRosterInFlight.clear();
  loginRosterBackoffUntil.clear();
  loginRosterRecoveryGrants.clear();
}

function normalizeStudentSessionRecoveryToken(value) {
  const token = String(value || '').trim();
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function normalizeEphemeralStudentBearer(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 16 * 1024
    ? value
    : null;
}

function normalizeStudentSessionRecoverySchoolId(value) {
  const schoolId = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(schoolId) ? schoolId : null;
}

function normalizeStudentSessionRecoveryOpaqueId(value, prefix) {
  const opaqueId = String(value || '').trim();
  if (!opaqueId || opaqueId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(opaqueId)) return null;
  return prefix && !opaqueId.startsWith(prefix) ? null : opaqueId;
}

function generateStudentSessionRecoveryGeneration() {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  return `recovery_${String(random).replace(/[^A-Za-z0-9_-]/g, '')}`;
}

function generateLoginRosterRecoveryGrantId() {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  return `roster_${String(random).replace(/[^A-Za-z0-9_-]/g, '')}`;
}

function normalizeStudentSessionRecoveryRecord(raw, state, nowValue = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const token = normalizeStudentSessionRecoveryToken(raw.token);
  const serverOrigin = normalizedServerOrigin(raw.serverOrigin);
  const schoolId = normalizeStudentSessionRecoverySchoolId(raw.schoolId);
  const authContextId = normalizeStudentSessionRecoveryOpaqueId(raw.authContextId, 'auth_');
  const generation = normalizeStudentSessionRecoveryOpaqueId(raw.generation, 'recovery_');
  const createdAt = Number(raw.createdAt);
  if (
    !token || !serverOrigin || !schoolId || !authContextId || !generation
    || !Number.isFinite(createdAt) || createdAt <= 0
  ) return null;
  const record = {
    state,
    generation,
    serverOrigin,
    schoolId,
    token,
    authContextId,
    createdAt,
  };
  if (state === 'pending') {
    const pendingSinceAt = Number(raw.pendingSinceAt);
    const attemptCount = Math.max(0, Math.min(100, Math.floor(Number(raw.attemptCount) || 0)));
    const nextAttemptAt = Number(raw.nextAttemptAt);
    const discardAt = Number(raw.discardAt);
    if (
      !Number.isFinite(pendingSinceAt) || pendingSinceAt <= 0
      || !Number.isFinite(nextAttemptAt) || nextAttemptAt <= 0
      || !Number.isFinite(discardAt) || discardAt <= pendingSinceAt
      || discardAt > pendingSinceAt + STUDENT_SESSION_RECOVERY_PENDING_TTL_MS
      || discardAt <= nowValue
    ) return null;
    record.pendingSinceAt = pendingSinceAt;
    record.attemptCount = attemptCount;
    record.nextAttemptAt = Math.min(nextAttemptAt, discardAt);
    record.discardAt = discardAt;
    // 2.7.4 pending records did not persist intent. Treat them as resumable so
    // an update cannot repeat the release-before-roster race that hid the
    // student's name. Every new pending record writes an explicit intent.
    record.intent = raw.intent === STUDENT_SESSION_RECOVERY_INTENT_RELEASE
      ? STUDENT_SESSION_RECOVERY_INTENT_RELEASE
      : STUDENT_SESSION_RECOVERY_INTENT_RESUME;
  }
  return Object.freeze(record);
}

function normalizeStudentSessionRecoveryState(raw, nowValue = Date.now()) {
  const state = emptyStudentSessionRecoveryState();
  if (
    !raw || typeof raw !== 'object' || Array.isArray(raw)
    || raw.schemaVersion !== STUDENT_SESSION_RECOVERY_SCHEMA_VERSION
  ) return Object.freeze({ ...state, pending: Object.freeze([]) });
  state.armed = normalizeStudentSessionRecoveryRecord(raw.armed, 'armed', nowValue);
  const seenGenerations = new Set(state.armed ? [state.armed.generation] : []);
  const seenTokens = new Set(state.armed ? [state.armed.token] : []);
  state.pending = (Array.isArray(raw.pending) ? raw.pending : [])
    .map((record) => normalizeStudentSessionRecoveryRecord(record, 'pending', nowValue))
    .filter((record) => {
      if (!record || seenGenerations.has(record.generation) || seenTokens.has(record.token)) return false;
      seenGenerations.add(record.generation);
      seenTokens.add(record.token);
      return true;
    })
    .sort((a, b) => b.pendingSinceAt - a.pendingSinceAt)
    .slice(0, STUDENT_SESSION_RECOVERY_MAX_PENDING);
  return Object.freeze({
    schemaVersion: STUDENT_SESSION_RECOVERY_SCHEMA_VERSION,
    armed: state.armed,
    pending: Object.freeze(state.pending),
  });
}

function studentSessionRecoveryStateHasRecords(state = studentSessionRecoveryState) {
  return Boolean(state?.armed || state?.pending?.length);
}

function studentSessionRecoveryMaterialMatches(left, right) {
  const material = (state) => [state?.armed, ...(state?.pending || [])]
    .filter(Boolean)
    .map((record) => [
      record.state,
      record.generation,
      record.serverOrigin,
      record.schoolId,
      record.token,
      record.authContextId,
      record.intent || null,
    ])
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  return JSON.stringify(material(left)) === JSON.stringify(material(right));
}

function resolvedAuthGateSchoolId(binding = authGateConfigBinding()) {
  if (binding.schoolId) return binding.schoolId;
  return sharedSignInLoginConfig.phase === 'ready'
    && sharedSignInLoginConfig.bindingKey === authGateConfigBindingKey(binding)
    ? normalizeStudentSessionRecoverySchoolId(sharedSignInLoginConfig.schoolId)
    : null;
}

function newestCurrentAuthorityRecoveryRecord(
  state = studentSessionRecoveryState,
  options = {},
) {
  if (hasStudentAuth()) return null;
  const binding = authGateConfigBinding();
  const schoolId = resolvedAuthGateSchoolId(binding);
  if (!binding.serverOrigin || !schoolId) return null;
  const nowValue = Date.now();
  return [state?.armed, ...(state?.pending || [])]
    .filter((record) => Boolean(
      record
      && record.serverOrigin === binding.serverOrigin
      && (!schoolId || record.schoolId === schoolId)
      && (
        options.resumeOnly !== true
        || record.state === 'armed'
        || record.intent === STUDENT_SESSION_RECOVERY_INTENT_RESUME
      )
      && (record.state !== 'pending' || record.discardAt > nowValue)
    ))
    .sort((left, right) => (
      Number(right.createdAt || 0) - Number(left.createdAt || 0)
      || Number(right.pendingSinceAt || 0) - Number(left.pendingSinceAt || 0)
    ))[0] || null;
}

function recoveryGenerationsReservedForGate(state = studentSessionRecoveryState) {
  if (hasStudentAuth()) return new Set();
  const binding = authGateConfigBinding();
  if (!binding.serverOrigin) return new Set();
  const schoolId = resolvedAuthGateSchoolId(binding);
  if (schoolId) {
    const newest = newestCurrentAuthorityRecoveryRecord(state, { resumeOnly: true });
    return new Set(newest ? [newest.generation] : []);
  }
  // A slug-only cold start has not yet learned which tenant id the managed
  // slug names. Releasing any same-origin capability here could destroy the
  // exact one the authoritative login-config response is about to select.
  return new Set([state?.armed, ...(state?.pending || [])]
    .filter((record) => Boolean(
      record
      && record.serverOrigin === binding.serverOrigin
      && (
        record.state === 'armed'
        || record.intent === STUDENT_SESSION_RECOVERY_INTENT_RESUME
      )
    ))
    .map((record) => record.generation));
}

function installStudentSessionRecoveryState(state) {
  const normalized = normalizeStudentSessionRecoveryState(state);
  const materialChanged = !studentSessionRecoveryMaterialMatches(
    studentSessionRecoveryState,
    normalized,
  );
  studentSessionRecoveryState = normalized;
  studentSessionRecoveryLoaded = true;
  if (materialChanged) {
    studentSessionRecoveryRevision += 1;
    resetLoginRosterRuntimeCache();
  }
  return studentSessionRecoveryState;
}

async function scheduleStudentSessionRecoveryAlarm() {
  const pending = studentSessionRecoveryState.pending || [];
  if (pending.length === 0) {
    await chrome.alarms.clear(STUDENT_SESSION_RECOVERY_ALARM).catch(() => false);
    return;
  }
  const reservedGenerations = recoveryGenerationsReservedForGate();
  const nextBoundary = pending.reduce((earliest, record) => Math.min(
    earliest,
    reservedGenerations.has(record.generation) ? record.discardAt : record.nextAttemptAt,
    record.discardAt,
  ), Number.POSITIVE_INFINITY);
  await chrome.alarms.clear(STUDENT_SESSION_RECOVERY_ALARM).catch(() => false);
  chrome.alarms.create(STUDENT_SESSION_RECOVERY_ALARM, {
    when: Math.max(Date.now() + 100, nextBoundary),
  });
}

async function ensureStudentSessionRecoveryLoaded(rawState) {
  await trustedLocalStorageAccessPromise;
  if (studentSessionRecoveryLoaded) return studentSessionRecoveryState;
  if (studentSessionRecoveryLoadPromise) return studentSessionRecoveryLoadPromise;
  const run = (async () => {
    const raw = rawState === undefined
      ? (await durableLocalKv.get([STUDENT_SESSION_RECOVERY_STORAGE_KEY]))[
        STUDENT_SESSION_RECOVERY_STORAGE_KEY
      ]
      : rawState;
    const normalized = normalizeStudentSessionRecoveryState(raw);
    installStudentSessionRecoveryState(normalized);
    if (studentSessionRecoveryStateHasRecords(normalized)) {
      await durableLocalKv.set({ [STUDENT_SESSION_RECOVERY_STORAGE_KEY]: normalized });
    } else if (raw !== undefined) {
      await durableLocalKv.remove(STUDENT_SESSION_RECOVERY_STORAGE_KEY);
    }
    await scheduleStudentSessionRecoveryAlarm();
    return studentSessionRecoveryState;
  })();
  studentSessionRecoveryLoadPromise = run.finally(() => {
    studentSessionRecoveryLoadPromise = null;
  });
  return studentSessionRecoveryLoadPromise;
}

function enqueueStudentSessionRecoveryMutation(mutation) {
  const run = studentSessionRecoveryMutationTail.then(async () => {
    await ensureStudentSessionRecoveryLoaded();
    return mutation();
  }, async () => {
    await ensureStudentSessionRecoveryLoaded();
    return mutation();
  });
  studentSessionRecoveryMutationTail = run.catch(() => undefined);
  return run;
}

async function persistStudentSessionRecoveryState(nextState) {
  const normalized = normalizeStudentSessionRecoveryState(nextState);
  if (studentSessionRecoveryStateHasRecords(normalized)) {
    await durableLocalKv.set({ [STUDENT_SESSION_RECOVERY_STORAGE_KEY]: normalized });
  } else {
    await durableLocalKv.remove(STUDENT_SESSION_RECOVERY_STORAGE_KEY);
  }
  installStudentSessionRecoveryState(normalized);
  await scheduleStudentSessionRecoveryAlarm();
  return studentSessionRecoveryState;
}

function pendingStudentSessionRecoveryRecord(
  record,
  nowValue = Date.now(),
  intent = STUDENT_SESSION_RECOVERY_INTENT_RELEASE,
) {
  return normalizeStudentSessionRecoveryRecord({
    ...record,
    state: 'pending',
    pendingSinceAt: nowValue,
    attemptCount: 0,
    nextAttemptAt: nowValue,
    discardAt: nowValue + STUDENT_SESSION_RECOVERY_PENDING_TTL_MS,
    intent,
  }, 'pending', nowValue - 1);
}

async function armStudentSessionRecovery(rawRecord, options = {}) {
  const createdAt = Date.now();
  const armed = normalizeStudentSessionRecoveryRecord({
    state: 'armed',
    generation: generateStudentSessionRecoveryGeneration(),
    serverOrigin: rawRecord?.serverOrigin,
    schoolId: rawRecord?.schoolId,
    token: rawRecord?.token,
    authContextId: rawRecord?.authContextId,
    createdAt,
  }, 'armed', createdAt);
  if (!armed) throw new Error('Student session recovery authority was invalid');
  return enqueueStudentSessionRecoveryMutation(async () => {
    const discardGeneration = String(options.discardGeneration || '');
    let pending = studentSessionRecoveryState.pending.filter(
      (record) => record.generation !== discardGeneration,
    );
    const priorArmed = studentSessionRecoveryState.armed;
    if (priorArmed && priorArmed.generation !== discardGeneration) {
      const promoted = pendingStudentSessionRecoveryRecord(priorArmed, createdAt);
      if (promoted) pending = [promoted, ...pending];
    }
    await persistStudentSessionRecoveryState({
      schemaVersion: STUDENT_SESSION_RECOVERY_SCHEMA_VERSION,
      armed,
      pending,
    });
    return armed;
  });
}

async function queuePendingStudentSessionRecoveryCleanup(rawRecord, options = {}) {
  const queuedAt = Date.now();
  const initialPendingRecord = pendingStudentSessionRecoveryRecord(
    rawRecord,
    queuedAt,
    STUDENT_SESSION_RECOVERY_INTENT_RELEASE,
  );
  const retryDelay = Math.max(
    studentSessionRecoveryRetryDelay(1),
    Number(options.retryAfterMs) || 0,
  );
  const pendingRecord = initialPendingRecord && normalizeStudentSessionRecoveryRecord({
    ...initialPendingRecord,
    attemptCount: 1,
    nextAttemptAt: Math.min(initialPendingRecord.discardAt, queuedAt + retryDelay),
  }, 'pending', queuedAt - 1);
  if (!pendingRecord) return false;
  return enqueueStudentSessionRecoveryMutation(async () => {
    const matchingArmed = studentSessionRecoveryState.armed
      && (
        studentSessionRecoveryState.armed.token === pendingRecord.token
        || studentSessionRecoveryState.armed.generation === pendingRecord.generation
      )
      ? studentSessionRecoveryState.armed
      : null;
    const matchingPending = studentSessionRecoveryState.pending.find((record) => (
      record.token === pendingRecord.token
      || record.generation === pendingRecord.generation
    ));
    const sourceRecord = matchingPending || matchingArmed || pendingRecord;
    const retryRecord = normalizeStudentSessionRecoveryRecord({
      ...sourceRecord,
      state: 'pending',
      intent: STUDENT_SESSION_RECOVERY_INTENT_RELEASE,
      pendingSinceAt: matchingPending?.pendingSinceAt || queuedAt,
      attemptCount: Math.max(1, Number(matchingPending?.attemptCount) || 0),
      nextAttemptAt: Math.min(
        Number(sourceRecord.discardAt || pendingRecord.discardAt),
        Math.max(
          Number(matchingPending?.nextAttemptAt) || 0,
          queuedAt + retryDelay,
        ),
      ),
      discardAt: Number(sourceRecord.discardAt || pendingRecord.discardAt),
    }, 'pending', queuedAt - 1);
    if (!retryRecord) return false;
    const pending = [
      retryRecord,
      ...studentSessionRecoveryState.pending.filter((record) => (
        record.token !== retryRecord.token
        && record.generation !== retryRecord.generation
      )),
    ]
      .slice(0, STUDENT_SESSION_RECOVERY_MAX_PENDING);
    await persistStudentSessionRecoveryState({
      schemaVersion: STUDENT_SESSION_RECOVERY_SCHEMA_VERSION,
      armed: matchingArmed ? null : studentSessionRecoveryState.armed,
      pending,
    });
    return true;
  });
}

async function transitionStudentSessionRecoveryForAuthClear(authContextId, options = {}) {
  const expectedAuthContextId = normalizeStudentSessionRecoveryOpaqueId(authContextId, 'auth_');
  const serverSessionEnded = options.serverSessionEnded === true;
  const pendingIntent = options.preserveForGate === true
    ? STUDENT_SESSION_RECOVERY_INTENT_RESUME
    : STUDENT_SESSION_RECOVERY_INTENT_RELEASE;
  return enqueueStudentSessionRecoveryMutation(async () => {
    const armed = studentSessionRecoveryState.armed;
    const matchingArmed = Boolean(
      armed && (!expectedAuthContextId || armed.authContextId === expectedAuthContextId)
    );
    const matchingPending = Boolean(
      expectedAuthContextId
      && studentSessionRecoveryState.pending.some(
        (record) => record.authContextId === expectedAuthContextId,
      )
    );
    let pending = studentSessionRecoveryState.pending;
    let nextArmed = armed;
    if (serverSessionEnded) {
      if (matchingArmed) nextArmed = null;
      if (expectedAuthContextId) {
        const filteredPending = pending.filter(
          (record) => record.authContextId !== expectedAuthContextId,
        );
        if (filteredPending.length !== pending.length) pending = filteredPending;
      }
    } else if (armed && matchingArmed) {
      const promoted = pendingStudentSessionRecoveryRecord(armed, Date.now(), pendingIntent);
      nextArmed = null;
      if (promoted) pending = [promoted, ...pending];
    } else if (
      expectedAuthContextId
      && pendingIntent === STUDENT_SESSION_RECOVERY_INTENT_RELEASE
      && matchingPending
    ) {
      const normalizedAt = Date.now() - 1;
      pending = pending.map((record) => (
        record.authContextId === expectedAuthContextId
          ? normalizeStudentSessionRecoveryRecord({
            ...record,
            intent: STUDENT_SESSION_RECOVERY_INTENT_RELEASE,
          }, 'pending', normalizedAt)
          : record
      )).filter(Boolean);
    }
    if (nextArmed === armed && pending === studentSessionRecoveryState.pending) {
      return {
        handledExactRecovery: matchingArmed || matchingPending,
        transitioned: false,
      };
    }
    await persistStudentSessionRecoveryState({
      schemaVersion: STUDENT_SESSION_RECOVERY_SCHEMA_VERSION,
      armed: nextArmed,
      pending,
    });
    if (!serverSessionEnded && pending.length > 0) {
      flushStudentSessionRecovery({ maxRecords: 1 }).catch(() => {});
    }
    return {
      handledExactRecovery: matchingArmed || matchingPending,
      transitioned: true,
    };
  });
}

function studentSessionRecoveryRetryDelay(attemptCount) {
  const index = Math.min(
    Math.max(0, attemptCount - 1),
    STUDENT_SESSION_RECOVERY_RETRY_DELAYS_MS.length - 1,
  );
  return STUDENT_SESSION_RECOVERY_RETRY_DELAYS_MS[index];
}

async function attemptStudentSessionRecoveryRelease(record) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    STUDENT_SESSION_RECOVERY_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`${record.serverOrigin}/api/extension/session-release`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ClassPilot-Recovery ${record.token}`,
      },
      body: JSON.stringify({ schoolId: record.schoolId, reason: 'local_auth_cleared' }),
      signal: controller.signal,
    });
    if (response.ok) return { outcome: 'released', retryAfterMs: 0 };
    let responseCode = null;
    if (response.status === 400) {
      const data = await response.json().catch(() => ({}));
      responseCode = /^[A-Z][A-Z0-9_]{0,127}$/.test(String(data?.code || ''))
        ? String(data.code)
        : null;
    }
    if (response.status === 400 && responseCode === 'SESSION_RELEASE_INVALID') {
      return { outcome: 'terminal', retryAfterMs: 0 };
    }
    // Proxies and mixed-version edges can replace the structured SchoolPilot
    // response with an unstructured 401/403. Only the exact structured 400
    // above proves that this recovery capability can never become usable.
    return { outcome: 'retry', retryAfterMs: parseRetryAfterMs(response) };
  } catch {
    return { outcome: 'retry', retryAfterMs: 0 };
  } finally {
    clearTimeout(timeoutId);
  }
}

function captureSuccessfulManualLoginCleanupAuthority(data, context = {}) {
  const responseData = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const responseStudent = responseData.student
    && typeof responseData.student === 'object'
    && !Array.isArray(responseData.student)
    ? responseData.student
    : {};
  const createdAt = Date.now();
  const authContextId = normalizeStudentSessionRecoveryOpaqueId(
    context.authContextId,
    'auth_',
  );
  const serverOrigin = normalizedServerOrigin(context.serverOrigin);
  const schoolId = normalizeStudentSessionRecoverySchoolId(
    responseData.schoolId || responseStudent.schoolId || context.requestSchoolId,
  );
  const recoveryRecord = normalizeStudentSessionRecoveryRecord({
    state: 'armed',
    generation: generateStudentSessionRecoveryGeneration(),
    serverOrigin,
    schoolId,
    token: responseData.sessionRecovery?.token,
    authContextId,
    createdAt,
  }, 'armed', createdAt);
  return Object.freeze({
    authContextId,
    bearerToken: normalizeEphemeralStudentBearer(responseData.studentToken),
    deviceId: String(context.deviceId || '').trim() || null,
    recoveryRecord,
    serverOrigin,
  });
}

async function cleanupSuccessfulManualLoginResponse(authority, reason) {
  let exactOutcome = null;
  let serverSessionEnded = false;
  if (authority?.recoveryRecord) {
    exactOutcome = await attemptStudentSessionRecoveryRelease(authority.recoveryRecord);
    serverSessionEnded = exactOutcome.outcome === 'released';
  }
  if (
    !serverSessionEnded
    && authority?.bearerToken
    && authority.serverOrigin
    && authority.deviceId
  ) {
    serverSessionEnded = await notifyBackendOfStudentSignOut({
      token: authority.bearerToken,
      serverOrigin: authority.serverOrigin,
      deviceId: authority.deviceId,
    }, reason);
  }
  if (serverSessionEnded && authority?.authContextId) {
    await transitionStudentSessionRecoveryForAuthClear(
      authority.authContextId,
      { serverSessionEnded: true },
    );
  } else if (exactOutcome?.outcome === 'retry' && authority?.recoveryRecord) {
    await queuePendingStudentSessionRecoveryCleanup(authority.recoveryRecord, {
      retryAfterMs: exactOutcome.retryAfterMs,
    });
  }
  return serverSessionEnded;
}

async function applyStudentSessionRecoveryReleaseOutcome(record, outcome) {
  return enqueueStudentSessionRecoveryMutation(async () => {
    const current = studentSessionRecoveryState.pending.find(
      (candidate) => candidate.generation === record.generation,
    );
    if (!current || current.token !== record.token) return false;
    let pending = studentSessionRecoveryState.pending.filter(
      (candidate) => candidate.generation !== record.generation,
    );
    const nowValue = Date.now();
    if (outcome.outcome === 'retry' && nowValue < current.discardAt) {
      const attemptCount = current.attemptCount + 1;
      const retryDelay = Math.max(
        studentSessionRecoveryRetryDelay(attemptCount),
        Number(outcome.retryAfterMs) || 0,
      );
      const retryRecord = normalizeStudentSessionRecoveryRecord({
        ...current,
        attemptCount,
        nextAttemptAt: Math.min(current.discardAt, nowValue + retryDelay),
      }, 'pending', nowValue - 1);
      if (retryRecord) pending = [retryRecord, ...pending];
    }
    await persistStudentSessionRecoveryState({
      schemaVersion: STUDENT_SESSION_RECOVERY_SCHEMA_VERSION,
      armed: studentSessionRecoveryState.armed,
      pending,
    });
    return true;
  });
}

async function flushStudentSessionRecovery(options = {}) {
  if (studentSessionRecoveryFlushPromise) return studentSessionRecoveryFlushPromise;
  const run = (async () => {
    await ensureStudentSessionRecoveryLoaded();
    const nowValue = Date.now();
    const forceGeneration = normalizeStudentSessionRecoveryOpaqueId(
      options.forceGeneration,
      'recovery_',
    );
    const maxRecords = Math.max(1, Math.min(
      STUDENT_SESSION_RECOVERY_MAX_PENDING,
      Number(options.maxRecords) || STUDENT_SESSION_RECOVERY_MAX_PENDING,
    ));
    const reservedGenerations = recoveryGenerationsReservedForGate();
    const eligible = studentSessionRecoveryState.pending.filter(
      (record) => record.discardAt > nowValue && !reservedGenerations.has(record.generation),
    );
    const forced = forceGeneration
      ? eligible.find((record) => record.generation === forceGeneration)
      : null;
    const due = [
      ...(forced ? [forced] : []),
      ...eligible.filter((record) => (
        record.generation !== forceGeneration && record.nextAttemptAt <= nowValue
      )),
    ].slice(0, maxRecords);
    for (const record of due) {
      const outcome = await attemptStudentSessionRecoveryRelease(record);
      await applyStudentSessionRecoveryReleaseOutcome(record, outcome);
    }
    await enqueueStudentSessionRecoveryMutation(async () => {
      const currentTime = Date.now();
      const pending = studentSessionRecoveryState.pending.filter(
        (record) => record.discardAt > currentTime,
      );
      if (pending.length !== studentSessionRecoveryState.pending.length) {
        await persistStudentSessionRecoveryState({
          schemaVersion: STUDENT_SESSION_RECOVERY_SCHEMA_VERSION,
          armed: studentSessionRecoveryState.armed,
          pending,
        });
      } else {
        await scheduleStudentSessionRecoveryAlarm();
      }
    });
    return true;
  })();
  studentSessionRecoveryFlushPromise = run;
  try {
    return await run;
  } finally {
    if (studentSessionRecoveryFlushPromise === run) studentSessionRecoveryFlushPromise = null;
  }
}

function matchingStudentSessionRecoveryRecord() {
  return newestCurrentAuthorityRecoveryRecord();
}

async function prepareStudentSessionRecoveryForGate(options = {}) {
  await ensureStudentSessionRecoveryLoaded();
  if (!hasStudentAuth() && studentSessionRecoveryState.armed) {
    await transitionStudentSessionRecoveryForAuthClear(null, {
      serverSessionEnded: false,
      preserveForGate: true,
    });
  }
  if (!resolvedAuthGateSchoolId()) {
    await refreshSharedSignInLoginConfig({
      force: false,
      reason: 'recovery_school_resolution',
      managedConfigAlreadyApplied: true,
    }).catch(() => {});
  }
  // The newest exact school/origin capability is the only safe way to reveal
  // and atomically replace the still-authoritative same-device session. Keep it
  // reserved for roster/login even when an ordinary 204 release would make the
  // name eventually reappear. Cleanup is limited to older or mismatched rows.
  await flushStudentSessionRecovery({ maxRecords: 1 });
  return matchingStudentSessionRecoveryRecord();
}

async function reconcileStudentSessionRecoveryAtWorkerWake(authStored, options = {}) {
  await ensureStudentSessionRecoveryLoaded(authStored?.[STUDENT_SESSION_RECOVERY_STORAGE_KEY]);
  const armed = studentSessionRecoveryState.armed;
  const storedAuthContextId = normalizeStudentSessionRecoveryOpaqueId(
    authStored?.authContextId,
    'auth_',
  );
  const hasCompleteManualAuth = isManualIdentitySource(authStored?.identitySource)
    && [
      authStored?.studentToken,
      authStored?.activeStudentId,
      authStored?.activeStudentSessionId,
    ].every((value) => typeof value === 'string' && value.trim().length > 0);
  if (!armed) {
    if (studentSessionRecoveryState.pending.length > 0 && !hasCompleteManualAuth) {
      CONFIG.autoRegistrationPaused = true;
      await durableLocalKv.set({ autoRegistrationPaused: true });
    }
    flushStudentSessionRecovery({ maxRecords: 1 }).catch(() => {});
    return;
  }
  const currentBinding = authGateConfigBinding();
  const mayRemainArmed = options.forceReauthentication !== true
    && options.authRestoreBlocked !== true
    && hasCompleteManualAuth
    && storedAuthContextId === armed.authContextId
    && currentBinding.serverOrigin === armed.serverOrigin
    && currentBinding.schoolId === armed.schoolId;
  if (!mayRemainArmed) {
    // A durable recovery capability with no matching browser-session bearer
    // means Chrome restarted/updated or an interrupted commit was recovered.
    // Persist the manual-login fence before authStateRestorePromise can open;
    // a detectable Chrome profile must not silently register over this gate.
    CONFIG.autoRegistrationPaused = true;
    await durableLocalKv.set({ autoRegistrationPaused: true });
    await transitionStudentSessionRecoveryForAuthClear(storedAuthContextId, {
      serverSessionEnded: false,
      preserveForGate: options.preserveForGate !== false,
    });
  }
  flushStudentSessionRecovery({ maxRecords: 1 }).catch(() => {});
}

function bindLoginRosterRecoveryGrant(record, students, cacheKey) {
  const normalizedCacheKey = String(cacheKey || '');
  if (!normalizedCacheKey || !record) {
    if (normalizedCacheKey) clearLoginRosterRecoveryGrant(normalizedCacheKey);
    return null;
  }
  const rosterStudents = Array.isArray(students) ? students : [];
  const hasReclaimableStudent = rosterStudents.some(
    (student) => student?.reclaimable === true && student?.id,
  );
  const selectableStudentIds = new Set(
    rosterStudents
      .filter((student) => student?.hasPin === true && student?.id)
      .map((student) => String(student.id)),
  );
  if (!hasReclaimableStudent || selectableStudentIds.size === 0) {
    clearLoginRosterRecoveryGrant(normalizedCacheKey);
    return null;
  }
  const existing = loginRosterRecoveryGrants.get(normalizedCacheKey);
  const existingStudentIds = existing?.studentIds instanceof Set
    ? [...existing.studentIds]
    : [];
  if (
    existing
    && existing.recoveryRevision === studentSessionRecoveryRevision
    && existing.recordGeneration === record.generation
    && existing.serverOrigin === record.serverOrigin
    && existing.schoolId === record.schoolId
    && existing.token === record.token
    && existingStudentIds.length === selectableStudentIds.size
    && existingStudentIds.every((studentId) => selectableStudentIds.has(studentId))
  ) {
    return existing.grantId;
  }
  const grantId = generateLoginRosterRecoveryGrantId();
  loginRosterRecoveryGrants.set(normalizedCacheKey, {
    authorizationKind: 'recovery',
    grantId,
    cacheKey: normalizedCacheKey,
    recoveryRevision: studentSessionRecoveryRevision,
    recordGeneration: record.generation,
    serverOrigin: record.serverOrigin,
    schoolId: record.schoolId,
    token: record.token,
    studentIds: selectableStudentIds,
  });
  while (loginRosterRecoveryGrants.size > 12) {
    loginRosterRecoveryGrants.delete(loginRosterRecoveryGrants.keys().next().value);
  }
  return grantId;
}

function bindLoginRosterDeviceContinuityGrant(record, students, cacheKey) {
  const normalizedCacheKey = String(cacheKey || '');
  if (!normalizedCacheKey || !record) {
    if (normalizedCacheKey) clearLoginRosterRecoveryGrant(normalizedCacheKey);
    return null;
  }
  const selectableStudentIds = new Set(
    (Array.isArray(students) ? students : [])
      .filter((student) => student?.hasPin === true && student?.id)
      .map((student) => String(student.id)),
  );
  if (selectableStudentIds.size === 0) {
    clearLoginRosterRecoveryGrant(normalizedCacheKey);
    return null;
  }
  const existing = loginRosterRecoveryGrants.get(normalizedCacheKey);
  const existingStudentIds = existing?.studentIds instanceof Set ? [...existing.studentIds] : [];
  if (
    existing?.authorizationKind === 'device'
    && existing.continuityRevision === managedDeviceContinuityRevision
    && existing.recordGeneration === record.generation
    && existing.serverOrigin === record.serverOrigin
    && existing.schoolId === record.schoolId
    && existing.token === record.proof
    && existingStudentIds.length === selectableStudentIds.size
    && existingStudentIds.every((studentId) => selectableStudentIds.has(studentId))
  ) return existing.grantId;

  const grantId = generateLoginRosterRecoveryGrantId();
  loginRosterRecoveryGrants.set(normalizedCacheKey, {
    authorizationKind: 'device',
    grantId,
    cacheKey: normalizedCacheKey,
    continuityRevision: managedDeviceContinuityRevision,
    recordGeneration: record.generation,
    recoveryGeneration: record.recoveryGeneration || null,
    serverOrigin: record.serverOrigin,
    schoolId: record.schoolId,
    token: record.proof,
    studentIds: selectableStudentIds,
  });
  while (loginRosterRecoveryGrants.size > 12) {
    loginRosterRecoveryGrants.delete(loginRosterRecoveryGrants.keys().next().value);
  }
  return grantId;
}

function bindLoginRosterAuthorizationGrant(recoveryRecord, continuityRecord, students, cacheKey) {
  return recoveryRecord
    ? bindLoginRosterRecoveryGrant(recoveryRecord, students, cacheKey)
    : bindLoginRosterDeviceContinuityGrant(continuityRecord, students, cacheKey);
}

function clearLoginRosterRecoveryGrant(cacheKey) {
  const normalizedCacheKey = String(cacheKey || '');
  return normalizedCacheKey ? loginRosterRecoveryGrants.delete(normalizedCacheKey) : false;
}

function recoveryGrantForStudentLogin(studentId, grantId) {
  const normalizedStudentId = String(studentId || '').trim();
  const normalizedGrantId = normalizeStudentSessionRecoveryOpaqueId(grantId, 'roster_');
  if (!normalizedStudentId || !normalizedGrantId) return null;
  const currentBinding = authGateConfigBinding();
  const currentSchoolId = resolvedAuthGateSchoolId(currentBinding);
  const recoveryRecords = [
    studentSessionRecoveryState.armed,
    ...studentSessionRecoveryState.pending,
  ];
  for (const [cacheKey, grant] of loginRosterRecoveryGrants) {
    if (grant.authorizationKind === 'device') {
      const proof = currentManagedDeviceContinuityProof();
      const current = grant.continuityRevision === managedDeviceContinuityRevision
        && currentBinding.serverOrigin === grant.serverOrigin
        && currentSchoolId === grant.schoolId
        && proof?.generation === grant.recordGeneration
        && proof?.proof === grant.token;
      if (!current) {
        loginRosterRecoveryGrants.delete(cacheKey);
        continue;
      }
      if (grant.grantId === normalizedGrantId && grant.studentIds.has(normalizedStudentId)) {
        return grant;
      }
      continue;
    }
    const record = recoveryRecords.find(
      (candidate) => candidate?.generation === grant.recordGeneration,
    );
    const current = grant.recoveryRevision === studentSessionRecoveryRevision
      && currentBinding.serverOrigin === grant.serverOrigin
      && currentSchoolId === grant.schoolId
      && record?.token === grant.token;
    if (!current) {
      loginRosterRecoveryGrants.delete(cacheKey);
      continue;
    }
    if (grant.grantId === normalizedGrantId && grant.studentIds.has(normalizedStudentId)) {
      return grant;
    }
  }
  return null;
}

function recoveryGrantForEmailStudentLogin() {
  const record = matchingStudentSessionRecoveryRecord();
  const proof = currentManagedDeviceContinuityProof(record);
  if (proof) {
    return {
      authorizationKind: 'device',
      continuityRevision: managedDeviceContinuityRevision,
      recordGeneration: proof.generation,
      recoveryGeneration: proof.recoveryGeneration || null,
      serverOrigin: proof.serverOrigin,
      schoolId: proof.schoolId,
      token: proof.proof,
    };
  }
  const recoveryGrant = recoveryAuthorizationGrantForRecord(record);
  if (recoveryGrant) return recoveryGrant;
  const unboundProof = currentManagedDeviceContinuityProof(null);
  return unboundProof ? {
    authorizationKind: 'device',
    continuityRevision: managedDeviceContinuityRevision,
    recordGeneration: unboundProof.generation,
    recoveryGeneration: null,
    serverOrigin: unboundProof.serverOrigin,
    schoolId: unboundProof.schoolId,
    token: unboundProof.proof,
  } : null;
}

function recoveryAuthorizationGrantForRecord(record) {
  if (!record) return null;
  const current = matchingStudentSessionRecoveryRecord();
  const binding = authGateConfigBinding();
  const schoolId = resolvedAuthGateSchoolId(binding);
  if (
    !current
    || current.generation !== record.generation
    || current.token !== record.token
    || current.serverOrigin !== binding.serverOrigin
    || current.serverOrigin !== record.serverOrigin
    || current.schoolId !== schoolId
    || current.schoolId !== record.schoolId
  ) return null;
  return {
    authorizationKind: 'recovery',
    recoveryRevision: studentSessionRecoveryRevision,
    recordGeneration: current.generation,
    serverOrigin: current.serverOrigin,
    schoolId: current.schoolId,
    token: current.token,
  };
}

function loginAuthorizationHeader(grant) {
  if (!grant?.token) return null;
  return grant.authorizationKind === 'device'
    ? `ClassPilot-Device ${grant.token}`
    : `ClassPilot-Recovery ${grant.token}`;
}

function trustedStudentAuthGatePresenceSource(sender, message) {
  if (
    sender?.id !== chrome.runtime.id
    || !Number.isInteger(sender.tab?.id)
    || sender.frameId !== 0
    || !/^[a-f0-9]{32}$/.test(String(message?.instanceId || ''))
  ) return null;
  const generation = Number(message?.rosterContextGeneration);
  if (!Number.isSafeInteger(generation) || generation < 0) return null;
  try {
    const sourceUrl = new URL(String(sender.url || sender.tab.url || ''));
    if (sourceUrl.protocol !== 'http:' && sourceUrl.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return Object.freeze({
    key: `${sender.tab.id}:${message.instanceId}`,
    rosterContextGeneration: generation,
  });
}

function pruneStudentAuthGatePresenceSources(nowValue = Date.now()) {
  for (const [key, source] of studentAuthGatePresenceSources) {
    if (nowValue - source.lastSeenAt >= STUDENT_AUTH_GATE_PRESENCE_SOURCE_TTL_MS) {
      studentAuthGatePresenceSources.delete(key);
    }
  }
}

function hasCurrentStudentAuthGatePresenceSource(nowValue = Date.now()) {
  pruneStudentAuthGatePresenceSources(nowValue);
  return [...studentAuthGatePresenceSources.values()].some((source) => (
    source.rosterContextGeneration === authGateRosterContextGeneration
    && nowValue - source.lastSeenAt < STUDENT_AUTH_GATE_PRESENCE_SOURCE_TTL_MS
  ));
}

function abortStudentAuthGatePresencePublishIfIdle() {
  if (hasCurrentStudentAuthGatePresenceSource()) return;
  studentAuthGatePresenceAbortController?.abort();
}

function captureStudentAuthGatePresenceGuard(grant) {
  return Object.freeze({
    authorizationKind: grant.authorizationKind,
    authMutationGeneration: studentAuthMutationGeneration,
    configGeneration: sharedSignInConfigGeneration,
    policyGeneration: managedAuthGatePolicyGeneration,
    rosterContextGeneration: authGateRosterContextGeneration,
    bindingKey: authGateConfigBindingKey(),
    recordGeneration: grant.recordGeneration,
    serverOrigin: grant.serverOrigin,
    schoolId: grant.schoolId,
    token: grant.token,
  });
}

function studentAuthGatePresenceGuardIsCurrent(guard) {
  if (
    !guard
    || hasStudentAuth()
    || !hasCurrentStudentAuthGatePresenceSource()
    || guard.authMutationGeneration !== studentAuthMutationGeneration
    || guard.configGeneration !== sharedSignInConfigGeneration
    || guard.policyGeneration !== managedAuthGatePolicyGeneration
    || guard.rosterContextGeneration !== authGateRosterContextGeneration
    || guard.bindingKey !== authGateConfigBindingKey()
    || guard.serverOrigin !== authGateConfigBinding().serverOrigin
    || guard.schoolId !== resolvedAuthGateSchoolId()
  ) return false;
  if (guard.authorizationKind === 'device') {
    const continuity = currentManagedDeviceContinuityProof();
    return continuity?.generation === guard.recordGeneration
      && continuity.proof === guard.token
      && continuity.serverOrigin === guard.serverOrigin
      && continuity.schoolId === guard.schoolId;
  }
  const recovery = matchingStudentSessionRecoveryRecord();
  return recovery?.generation === guard.recordGeneration
    && recovery.token === guard.token
    && recovery.serverOrigin === guard.serverOrigin
    && recovery.schoolId === guard.schoolId;
}

async function resolveStudentAuthGatePresenceGrant() {
  if (
    hasStudentAuth()
    || !hasCurrentStudentAuthGatePresenceSource()
    || !hasManagedSchoolSetup()
    || sharedSignInLoginConfig.phase !== 'ready'
  ) return null;
  const recoveryRecord = await prepareStudentSessionRecoveryForGate();
  if (!hasCurrentStudentAuthGatePresenceSource() || hasStudentAuth()) return null;
  const recoveryGrant = recoveryAuthorizationGrantForRecord(recoveryRecord);
  if (recoveryGrant) return recoveryGrant;
  const continuityRecord = await requestManagedDeviceContinuityProof({ recoveryRecord });
  if (!hasCurrentStudentAuthGatePresenceSource() || hasStudentAuth()) return null;
  if (continuityRecord) {
    return Object.freeze({
      authorizationKind: 'device',
      recordGeneration: continuityRecord.generation,
      serverOrigin: continuityRecord.serverOrigin,
      schoolId: continuityRecord.schoolId,
      token: continuityRecord.proof,
    });
  }
  return null;
}

function studentAuthGatePresenceRetryDelay(response) {
  if (!response) return STUDENT_AUTH_GATE_PRESENCE_RETRY_MS;
  if (response.status === 426) return STUDENT_AUTH_GATE_PRESENCE_UNNEGOTIATED_RETRY_MS;
  if (response.status === 429) {
    return Math.max(
      STUDENT_AUTH_GATE_PRESENCE_UNAVAILABLE_RETRY_MS,
      Number(parseRetryAfterMs(response)) || 0,
    );
  }
  if (response.status >= 500) return STUDENT_AUTH_GATE_PRESENCE_UNAVAILABLE_RETRY_MS;
  return STUDENT_AUTH_GATE_PRESENCE_RETRY_MS;
}

async function publishStudentAuthGatePresence() {
  if (studentAuthGatePresencePublishInFlight) return studentAuthGatePresencePublishInFlight;
  const nowValue = Date.now();
  if (!hasCurrentStudentAuthGatePresenceSource(nowValue)) return null;
  const retryContext = `${authGateConfigBindingKey()}:${authGateRosterContextGeneration}`;
  if (retryContext !== studentAuthGatePresenceRetryContext) {
    studentAuthGatePresenceRetryContext = retryContext;
    studentAuthGatePresenceRetryAt = 0;
    studentAuthGatePresenceLastDispatchAt = 0;
  }
  if (
    nowValue < studentAuthGatePresenceRetryAt
    || nowValue - studentAuthGatePresenceLastDispatchAt
      < STUDENT_AUTH_GATE_PRESENCE_MIN_PUBLISH_MS
  ) return null;

  const run = (async () => {
    await authStateRestorePromise;
    await awaitManagedAuthGatePolicyStable();
    await studentAuthMutationTail;
    const grant = await resolveStudentAuthGatePresenceGrant();
    if (!grant) return null;
    const guard = captureStudentAuthGatePresenceGuard(grant);
    if (!studentAuthGatePresenceGuardIsCurrent(guard)) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      STUDENT_AUTH_GATE_PRESENCE_REQUEST_TIMEOUT_MS,
    );
    studentAuthGatePresenceAbortController = controller;
    studentAuthGatePresenceLastDispatchAt = Date.now();
    let response = null;
    try {
      response = await fetch(`${guard.serverOrigin}/api/extension/session-gate-presence`, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-ClassPilot-Enrollment-Key': CONFIG.enrollmentKey,
          Authorization: loginAuthorizationHeader(guard),
        },
        body: JSON.stringify({
          schoolId: guard.schoolId,
          clientProtocolVersion: CLIENT_PROTOCOL_VERSION,
          capabilities: [...STUDENT_AUTH_GATE_PRESENCE_CAPABILITIES],
        }),
        signal: controller.signal,
      });
      if (!studentAuthGatePresenceGuardIsCurrent(guard)) return null;
      if (response.ok) {
        studentAuthGatePresenceRetryAt = 0;
        return true;
      }
      if (guard.authorizationKind === 'device' && response.status === 401) {
        await clearManagedDeviceContinuityState(guard.recordGeneration);
      }
      studentAuthGatePresenceRetryAt = Date.now()
        + studentAuthGatePresenceRetryDelay(response);
      return false;
    } catch {
      if (!controller.signal.aborted || hasCurrentStudentAuthGatePresenceSource()) {
        studentAuthGatePresenceRetryAt = Date.now()
          + STUDENT_AUTH_GATE_PRESENCE_RETRY_MS;
      }
      return false;
    } finally {
      clearTimeout(timeoutId);
      if (studentAuthGatePresenceAbortController === controller) {
        studentAuthGatePresenceAbortController = null;
      }
    }
  })();
  studentAuthGatePresencePublishInFlight = run.finally(() => {
    if (studentAuthGatePresencePublishInFlight === trackedRun) {
      studentAuthGatePresencePublishInFlight = null;
    }
  });
  const trackedRun = studentAuthGatePresencePublishInFlight;
  return trackedRun;
}

function noteStudentAuthGatePresence(message, sender) {
  const source = trustedStudentAuthGatePresenceSource(sender, message);
  if (!source) return false;
  if (message.present !== true) {
    studentAuthGatePresenceSources.delete(source.key);
    abortStudentAuthGatePresencePublishIfIdle();
    return true;
  }
  const previousSource = studentAuthGatePresenceSources.get(source.key);
  if (
    previousSource
    && previousSource.rosterContextGeneration !== source.rosterContextGeneration
  ) {
    studentAuthGatePresenceAbortController?.abort();
  }
  studentAuthGatePresenceSources.set(source.key, {
    rosterContextGeneration: source.rosterContextGeneration,
    lastSeenAt: Date.now(),
  });
  while (studentAuthGatePresenceSources.size > 64) {
    studentAuthGatePresenceSources.delete(studentAuthGatePresenceSources.keys().next().value);
  }
  publishStudentAuthGatePresence().catch(() => {});
  return true;
}

function removeStudentAuthGatePresenceSourcesForTab(tabId) {
  const prefix = `${tabId}:`;
  for (const key of studentAuthGatePresenceSources.keys()) {
    if (key.startsWith(prefix)) studentAuthGatePresenceSources.delete(key);
  }
  abortStudentAuthGatePresencePublishIfIdle();
}

function normalizeManagedDevicePreflightToken(value) {
  const credential = String(value || '').trim();
  return /^cpmp1\.[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43}$/.test(credential)
    ? credential
    : null;
}

function normalizeManagedDeviceContinuityProof(value) {
  const credential = String(value || '').trim();
  return /^cpmd1\.[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43}$/.test(credential)
    ? credential
    : null;
}

function normalizeEffectiveDeviceId(value) {
  const deviceId = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deviceId)
    ? deviceId
    : null;
}

function generateManagedDeviceContinuityGeneration() {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  return `continuity_${String(random).replace(/[^A-Za-z0-9_-]/g, '')}`;
}

function captureManagedDeviceContinuityGuard() {
  const binding = authGateConfigBinding();
  return Object.freeze({
    serverOrigin: binding.serverOrigin,
    schoolId: resolvedAuthGateSchoolId(binding),
    bindingKey: authGateConfigBindingKey(binding),
    policyGeneration: managedAuthGatePolicyGeneration,
    enrollmentKey: String(CONFIG.enrollmentKey || '').trim() || null,
  });
}

function managedDeviceContinuityGuardIsCurrent(guard) {
  const current = captureManagedDeviceContinuityGuard();
  return Boolean(
    guard
    && !hasStudentAuth()
    && guard.serverOrigin
    && guard.schoolId
    && guard.enrollmentKey
    && guard.serverOrigin === current.serverOrigin
    && guard.schoolId === current.schoolId
    && guard.bindingKey === current.bindingKey
    && guard.policyGeneration === current.policyGeneration
    && guard.enrollmentKey === current.enrollmentKey
  );
}

function normalizeManagedDeviceContinuityRecord(raw, nowValue = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const proof = normalizeManagedDeviceContinuityProof(raw.proof);
  const generation = normalizeStudentSessionRecoveryOpaqueId(raw.generation, 'continuity_');
  const serverOrigin = normalizedServerOrigin(raw.serverOrigin);
  const schoolId = normalizeStudentSessionRecoverySchoolId(raw.schoolId);
  const bindingKey = String(raw.bindingKey || '');
  const policyGeneration = Number(raw.policyGeneration);
  const expiresAt = Number(raw.expiresAt);
  const hasRecoveryGeneration = raw.recoveryGeneration !== null
    && raw.recoveryGeneration !== undefined;
  const recoveryGeneration = !hasRecoveryGeneration
    ? null
    : normalizeStudentSessionRecoveryOpaqueId(raw.recoveryGeneration, 'recovery_');
  if (
    !proof || !generation || !serverOrigin || !schoolId || !bindingKey
    || (hasRecoveryGeneration && !recoveryGeneration)
    || !Number.isSafeInteger(policyGeneration) || policyGeneration < 0
    || !Number.isFinite(expiresAt)
    || expiresAt <= nowValue + MANAGED_DEVICE_CONTINUITY_EXPIRY_SKEW_MS
    || expiresAt > nowValue + MANAGED_DEVICE_CONTINUITY_MAX_PROOF_TTL_MS
  ) return null;
  return Object.freeze({
    generation,
    proof,
    serverOrigin,
    schoolId,
    bindingKey,
    policyGeneration,
    recoveryGeneration,
    expiresAt,
  });
}

function managedDeviceContinuityMaterialMatches(left, right) {
  return Boolean(
    left === right
    || (
      left && right
      && left.generation === right.generation
      && left.proof === right.proof
      && left.serverOrigin === right.serverOrigin
      && left.schoolId === right.schoolId
      && left.bindingKey === right.bindingKey
      && left.policyGeneration === right.policyGeneration
      && left.recoveryGeneration === right.recoveryGeneration
      && left.expiresAt === right.expiresAt
    )
  );
}

function installManagedDeviceContinuityState(record) {
  if (!managedDeviceContinuityMaterialMatches(managedDeviceContinuityState, record)) {
    managedDeviceContinuityRevision += 1;
    resetLoginRosterRuntimeCache();
  }
  managedDeviceContinuityState = record || null;
  managedDeviceContinuityLoaded = true;
  return managedDeviceContinuityState;
}

async function clearManagedDeviceContinuityState(expectedGeneration = null) {
  if (
    expectedGeneration
    && managedDeviceContinuityState?.generation
    && managedDeviceContinuityState.generation !== expectedGeneration
  ) return false;
  await durableSessionKv.remove(MANAGED_DEVICE_CONTINUITY_SESSION_KEY).catch(() => {});
  installManagedDeviceContinuityState(null);
  return true;
}

async function ensureManagedDeviceContinuityLoaded() {
  if (managedDeviceContinuityLoaded) {
    const normalized = normalizeManagedDeviceContinuityRecord(managedDeviceContinuityState);
    if (normalized) return installManagedDeviceContinuityState(normalized);
    await clearManagedDeviceContinuityState();
    return null;
  }
  if (managedDeviceContinuityLoadPromise) return managedDeviceContinuityLoadPromise;
  const load = (async () => {
    if (!hasSessionStorage()) {
      installManagedDeviceContinuityState(null);
      return null;
    }
    const stored = await durableSessionKv.get([MANAGED_DEVICE_CONTINUITY_SESSION_KEY]);
    const normalized = normalizeManagedDeviceContinuityRecord(
      stored[MANAGED_DEVICE_CONTINUITY_SESSION_KEY],
    );
    installManagedDeviceContinuityState(normalized);
    if (!normalized && stored[MANAGED_DEVICE_CONTINUITY_SESSION_KEY] !== undefined) {
      await durableSessionKv.remove(MANAGED_DEVICE_CONTINUITY_SESSION_KEY);
    }
    return normalized;
  })();
  managedDeviceContinuityLoadPromise = load.finally(() => {
    managedDeviceContinuityLoadPromise = null;
  });
  return managedDeviceContinuityLoadPromise;
}

function currentManagedDeviceContinuityProof(expectedRecoveryRecord = undefined) {
  const state = normalizeManagedDeviceContinuityRecord(managedDeviceContinuityState);
  const guard = captureManagedDeviceContinuityGuard();
  if (!state || !managedDeviceContinuityGuardIsCurrent(guard)) return null;
  const currentRecoveryRecord = expectedRecoveryRecord === undefined
    ? matchingStudentSessionRecoveryRecord()
    : expectedRecoveryRecord;
  if (state.recoveryGeneration !== (currentRecoveryRecord?.generation || null)) return null;
  return state.serverOrigin === guard.serverOrigin
    && state.schoolId === guard.schoolId
    && state.bindingKey === guard.bindingKey
    && state.policyGeneration === guard.policyGeneration
    ? state
    : null;
}

function managedDeviceContinuityContractAccepted(data) {
  const accepted = new Set(Array.isArray(data?.acceptedCapabilities)
    ? data.acceptedCapabilities.map((value) => String(value || '').trim())
    : []);
  return data?.serverProtocolVersion === CLIENT_PROTOCOL_VERSION
    && MANAGED_DEVICE_CONTINUITY_CAPABILITIES.every((capability) => accepted.has(capability));
}

function isManagedDeviceContinuityUnauthorized(response, data) {
  return response?.status === 401
    && data?.code === 'CLASSPILOT_MANAGED_DEVICE_CONTINUITY_UNAUTHORIZED';
}

async function postManagedDeviceContinuityContract(guard, path, body, authorization = null) {
  if (!managedDeviceContinuityGuardIsCurrent(guard)) return null;
  const result = await fetchAuthGateRequest(`${guard.serverOrigin}${path}`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-ClassPilot-Enrollment-Key': guard.enrollmentKey,
      'X-School-Id': guard.schoolId,
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(body),
  });
  return managedDeviceContinuityGuardIsCurrent(guard) ? result : null;
}

async function requestManagedDeviceContinuityProof(options = {}) {
  await ensureManagedDeviceContinuityLoaded();
  if (!resolvedAuthGateSchoolId()) {
    await refreshSharedSignInLoginConfig({
      force: false,
      reason: 'device_continuity_school_resolution',
      managedConfigAlreadyApplied: true,
    }).catch(() => {});
  }
  const recoveryRecord = options.recoveryRecord || null;
  const current = currentManagedDeviceContinuityProof(recoveryRecord);
  if (current) return current;
  if (managedDeviceContinuityState) await clearManagedDeviceContinuityState();
  if (!hasSessionStorage()) return null;
  const readDirectoryDeviceId = typeof options.readDirectoryDeviceId === 'function'
    ? options.readDirectoryDeviceId
    : readManagedDirectoryDeviceIdWithRetry;
  if (managedDeviceContinuityIssuancePromise) {
    await managedDeviceContinuityIssuancePromise;
    const coalesced = currentManagedDeviceContinuityProof(recoveryRecord);
    return coalesced || requestManagedDeviceContinuityProof(options);
  }

  const guard = captureManagedDeviceContinuityGuard();
  if (!managedDeviceContinuityGuardIsCurrent(guard)) return null;
  const recoveryIsCurrent = () => !recoveryRecord
    || matchingStudentSessionRecoveryRecord()?.generation === recoveryRecord.generation;
  const run = (async () => {
    try {
      // The first request intentionally contains no Chrome directory identifier.
      // Only an exact SchoolPilot origin that advertises the capability may
      // cause the enterprise API to be read.
      const preflight = await postManagedDeviceContinuityContract(
        guard,
        '/api/classpilot/extension/device-continuity/preflight',
        {
          clientProtocolVersion: CLIENT_PROTOCOL_VERSION,
          capabilities: [...MANAGED_DEVICE_CONTINUITY_CAPABILITIES],
        },
      );
      const preflightToken = normalizeManagedDevicePreflightToken(
        preflight?.data?.preflightToken,
      );
      if (
        !preflight
        || !preflight.response.ok
        || !preflight.jsonValid
        || !preflightToken
        || !managedDeviceContinuityContractAccepted(preflight.data)
        || !recoveryIsCurrent()
      ) return null;

      const rawDirectoryDeviceId = options.directoryDeviceId === undefined
        ? await readDirectoryDeviceId()
        : String(options.directoryDeviceId || '').trim() || null;
      if (
        !managedDeviceContinuityGuardIsCurrent(guard)
        || !recoveryIsCurrent()
        || !rawDirectoryDeviceId
        || rawDirectoryDeviceId.length > 512
      ) return null;

      const issuance = await postManagedDeviceContinuityContract(
        guard,
        '/api/classpilot/extension/device-continuity',
        {
          directoryDeviceId: rawDirectoryDeviceId,
          ...(recoveryRecord ? { recoveryToken: recoveryRecord.token } : {}),
        },
        `ClassPilot-Preflight ${preflightToken}`,
      );
      const continuityProof = normalizeManagedDeviceContinuityProof(
        issuance?.data?.continuityProof,
      );
      const expiresInSeconds = Number(issuance?.data?.expiresInSeconds);
      if (
        !issuance
        || !issuance.response.ok
        || !issuance.jsonValid
        || !continuityProof
        || !Number.isFinite(expiresInSeconds)
        || expiresInSeconds <= 0
        || expiresInSeconds > MANAGED_DEVICE_CONTINUITY_MAX_PROOF_TTL_MS / 1000
        || !managedDeviceContinuityGuardIsCurrent(guard)
        || !recoveryIsCurrent()
      ) return null;

      const nowValue = Date.now();
      const record = normalizeManagedDeviceContinuityRecord({
        generation: generateManagedDeviceContinuityGeneration(),
        proof: continuityProof,
        serverOrigin: guard.serverOrigin,
        schoolId: guard.schoolId,
        bindingKey: guard.bindingKey,
        policyGeneration: guard.policyGeneration,
        recoveryGeneration: recoveryRecord?.generation || null,
        expiresAt: nowValue + (expiresInSeconds * 1000),
      }, nowValue);
      if (!record) return null;
      await durableSessionKv.set({ [MANAGED_DEVICE_CONTINUITY_SESSION_KEY]: record });
      if (!managedDeviceContinuityGuardIsCurrent(guard) || !recoveryIsCurrent()) {
        await durableSessionKv.remove(MANAGED_DEVICE_CONTINUITY_SESSION_KEY);
        return null;
      }
      installManagedDeviceContinuityState(record);
      return record;
    } catch {
      return null;
    }
  })();
  managedDeviceContinuityIssuancePromise = run.finally(() => {
    managedDeviceContinuityIssuancePromise = null;
  });
  return managedDeviceContinuityIssuancePromise;
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
  return `${origin}/passpilot/kiosk/simple?school=${encodeURIComponent(sharedSignInLoginConfig.schoolId)}&launch=gate`;
}

function readManagedDirectoryDeviceIdOnce(timeoutMs = 1500) {
  return Promise.race([
    new Promise((resolve) => {
      if (!chrome.enterprise?.deviceAttributes?.getDirectoryDeviceId) {
        resolve(null);
        return;
      }
      try {
        chrome.enterprise.deviceAttributes.getDirectoryDeviceId((value) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(typeof value === 'string' ? value.trim() || null : null);
        });
      } catch {
        resolve(null);
      }
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

async function readManagedDirectoryDeviceIdWithRetry() {
  if (managedKioskDirectoryProbeInFlight) return managedKioskDirectoryProbeInFlight;
  managedKioskDirectoryProbeInFlight = (async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const directoryDeviceId = await readManagedDirectoryDeviceIdOnce();
      if (directoryDeviceId) return directoryDeviceId;
      if (attempt < 2) {
        const baseDelay = attempt === 0 ? 150 : 400;
        const jitter = Math.floor(Math.random() * 150);
        await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));
      }
    }
    return null;
  })();
  try {
    return await managedKioskDirectoryProbeInFlight;
  } finally {
    // Transient enterprise API failures must be retried on the next explicit
    // click. Never cache either the raw directory id or a failure.
    managedKioskDirectoryProbeInFlight = null;
  }
}

function captureKioskLaunchGuard() {
  const fallbackUrl = kioskLaunchUrl();
  return Object.freeze({
    fallbackUrl,
    origin: kioskGateOrigin(),
    schoolId: String(sharedSignInLoginConfig.schoolId || '').trim() || null,
    enrollmentKey: String(CONFIG.enrollmentKey || '').trim() || null,
    managedPolicyGeneration: managedAuthGatePolicyGeneration,
    configGeneration: sharedSignInConfigGeneration,
  });
}

function kioskLaunchGuardIsCurrent(guard) {
  return Boolean(
    guard
    && guard.fallbackUrl === kioskLaunchUrl()
    && guard.origin === kioskGateOrigin()
    && guard.schoolId === (String(sharedSignInLoginConfig.schoolId || '').trim() || null)
    && guard.enrollmentKey === (String(CONFIG.enrollmentKey || '').trim() || null)
    && guard.managedPolicyGeneration === managedAuthGatePolicyGeneration
    && guard.configGeneration === sharedSignInConfigGeneration
  );
}

const KIOSK_LAUNCH_TICKET_V2_CAPABILITIES = Object.freeze([
  'scopedAuthorityChecksV1',
  'kioskLaunchTicketV2',
]);
const KIOSK_LAUNCH_TICKET_V2_MAX_EXPIRY_MS = 660 * 1000;

async function postKioskLaunchContract(fetcher, guard, path, body) {
  if (!kioskLaunchGuardIsCurrent(guard)) return { superseded: true };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetcher(`${guard.origin}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-ClassPilot-Enrollment-Key': guard.enrollmentKey,
        'X-School-Id': guard.schoolId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!kioskLaunchGuardIsCurrent(guard)) return { superseded: true };
    const data = await response.json().catch(() => ({}));
    if (!kioskLaunchGuardIsCurrent(guard)) return { superseded: true };
    return { response, data, superseded: false };
  } finally {
    clearTimeout(timeoutId);
  }
}

function kioskLaunchTicketV2Accepted(data) {
  if (data?.serverProtocolVersion !== CLIENT_PROTOCOL_VERSION) return false;
  const accepted = new Set(Array.isArray(data?.acceptedCapabilities)
    ? data.acceptedCapabilities.map((value) => String(value || '').trim())
    : []);
  return KIOSK_LAUNCH_TICKET_V2_CAPABILITIES.every((name) => accepted.has(name));
}

async function requestKioskLaunchUrl(options = {}) {
  const guard = options.guard || captureKioskLaunchGuard();
  if (!guard.fallbackUrl || !guard.enrollmentKey || !guard.origin) return guard.fallbackUrl;
  const fetcher = options.fetchImpl || globalThis.fetch;
  try {
    // Privacy gate: prove that this exact SchoolPilot origin accepts the V2
    // contract before Chrome's managed directory identifier is even read.
    const preflight = await postKioskLaunchContract(
      fetcher,
      guard,
      '/api/classpilot/kiosk/launch-ticket/preflight',
      {
        clientProtocolVersion: CLIENT_PROTOCOL_VERSION,
        capabilities: [...KIOSK_LAUNCH_TICKET_V2_CAPABILITIES],
      },
    );
    if (preflight.superseded) return null;
    if (!preflight.response.ok || !kioskLaunchTicketV2Accepted(preflight.data)) {
      return guard.fallbackUrl;
    }

    const directoryDeviceId = options.directoryDeviceId
      || await readManagedDirectoryDeviceIdWithRetry();
    if (!kioskLaunchGuardIsCurrent(guard)) return null;
    if (!directoryDeviceId) return guard.fallbackUrl;

    const issuance = await postKioskLaunchContract(
      fetcher,
      guard,
      '/api/classpilot/kiosk/launch-ticket',
      {
        directoryDeviceId,
        clientProtocolVersion: CLIENT_PROTOCOL_VERSION,
        capabilities: [...KIOSK_LAUNCH_TICKET_V2_CAPABILITIES],
      },
    );
    if (issuance.superseded) return null;
    if (!issuance.response.ok || !kioskLaunchTicketV2Accepted(issuance.data)) {
      return guard.fallbackUrl;
    }
    const ticket = String(issuance.data.ticket || '').trim();
    const expiresAt = parseBoundedExpiry(issuance.data.expiresAt);
    const nowValue = Date.now();
    if (!ticket || ticket.length > 2048
      || expiresAt <= nowValue
      || expiresAt > nowValue + KIOSK_LAUNCH_TICKET_V2_MAX_EXPIRY_MS) return guard.fallbackUrl;
    const launchUrl = new URL(guard.fallbackUrl);
    launchUrl.hash = `launchTicket=${encodeURIComponent(ticket)}`;
    return launchUrl.href;
  } catch {
    return kioskLaunchGuardIsCurrent(guard) ? guard.fallbackUrl : null;
  }
}

function publishableKioskLaunchGuard(guard) {
  return Object.freeze({
    fallbackUrl: guard?.fallbackUrl || null,
    origin: guard?.origin || null,
    schoolId: guard?.schoolId || null,
    managedPolicyGeneration: Number(guard?.managedPolicyGeneration),
    configGeneration: Number(guard?.configGeneration),
  });
}

function kioskLaunchValidationIsCurrent(rawGuard, launchUrl) {
  const currentGuard = captureKioskLaunchGuard();
  const normalizedGuard = publishableKioskLaunchGuard(rawGuard);
  const expectedGuard = publishableKioskLaunchGuard(currentGuard);
  if (
    normalizedGuard.fallbackUrl !== expectedGuard.fallbackUrl
    || normalizedGuard.origin !== expectedGuard.origin
    || normalizedGuard.schoolId !== expectedGuard.schoolId
    || normalizedGuard.managedPolicyGeneration !== expectedGuard.managedPolicyGeneration
    || normalizedGuard.configGeneration !== expectedGuard.configGeneration
  ) return false;
  return typeof launchUrl === 'string'
    && Boolean(launchUrl)
    && isKioskGateUrl(launchUrl);
}

// Refresh the tab cache - called when tabs change to keep cache accurate
async function refreshTabCache(expectedAuthContext = null) {
  let authContext = expectedAuthContext;
  if (!authContext) {
    try {
      authContext = captureAuthenticatedContext('tab cache refresh');
    } catch {
      return false;
    }
  }
  try {
    const allTabs = await chrome.tabs.query({});
    assertAuthenticatedContextCurrent(authContext, 'tab cache refresh');
    const httpTabs = allTabs.filter(tab => tab.url && tab.url.startsWith('http'));
    if (httpTabs.length > 0) {
      const snapshot = await buildOpaqueTabSnapshot(httpTabs, authContext);
      assertAuthenticatedContextCurrent(authContext, 'tab cache refresh');
      lastKnownTabs = snapshot.tabs;
      lastKnownTabsAuthBinding = monitoringEventAuthBindingForContext(authContext);
    } else {
      lastKnownTabs = [];
      lastKnownTabsAuthBinding = monitoringEventAuthBindingForContext(authContext);
    }
    return true;
  } catch (error) {
    // Ignore errors - cache will be updated on next successful query
    return false;
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
    console.warn('[Service Worker] Managed config read failed:', safeDiagnosticError(error));
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
  const managedFastAuthGateEnabled = Object.prototype.hasOwnProperty.call(
    managedConfig,
    'fastAuthGateEnabled',
  )
    ? extractManagedValue(managedConfig.fastAuthGateEnabled) !== false
    : true;
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
    fastAuthGateEnabled: managedFastAuthGateEnabled,
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
    fastAuthGateEnabled: descriptor.fastAuthGateEnabled,
  };
}

function managedAuthGatePolicyDescriptorsMatch(prior, current) {
  if (!prior || prior.schemaVersion !== 1 || !current || current.schemaVersion !== 1) {
    return false;
  }
  return [
    'serverOrigin',
    'serverManaged',
    'serverValid',
    'schoolId',
    'schoolIdManaged',
    'schoolSlug',
    'schoolSlugManaged',
    'enrollmentKeyManaged',
    'fastAuthGateEnabled',
  ].every((key) => prior[key] === current[key]);
}

function canonicalSchoolIdForUnchangedSlugPolicy(
  descriptor,
  priorManagedBinding,
  priorConfig = CONFIG,
) {
  const canonicalSchoolId = normalizeManagedString(priorConfig?.schoolId);
  if (
    !canonicalSchoolId
    || descriptor.schoolId
    || !descriptor.schoolSlugManaged
    || !descriptor.enrollmentKeyManaged
    || !priorManagedBinding
    || priorManagedBinding.schemaVersion !== 1
    || priorManagedBinding.schoolId !== null
    || priorManagedBinding.schoolIdManaged !== false
    || priorManagedBinding.schoolSlugManaged !== true
    || priorManagedBinding.enrollmentKeyManaged !== true
    || priorManagedBinding.serverManaged !== descriptor.serverManaged
    || priorManagedBinding.serverValid !== descriptor.serverValid
    || priorManagedBinding.serverOrigin !== descriptor.serverOrigin
  ) return null;
  const expectedServerOrigin = descriptor.serverManaged
    ? descriptor.serverOrigin
    : normalizedServerOrigin(DEFAULT_SERVER_URL);
  return normalizedServerOrigin(priorConfig?.serverUrl || DEFAULT_SERVER_URL) === expectedServerOrigin
    && normalizeManagedString(priorConfig?.schoolSlug) === descriptor.schoolSlug
    && normalizeManagedString(priorConfig?.enrollmentKey) === descriptor.enrollmentKey
    && priorManagedBinding.schoolSlug === descriptor.schoolSlug
    ? canonicalSchoolId
    : null;
}

function applyAuthoritativeManagedAuthGateSnapshot(
  managedConfig,
  priorManagedBinding,
  allowUnmanagedFallback,
  options = {},
) {
  const descriptor = managedAuthGatePolicyDescriptor(managedConfig);
  const preservedCanonicalSchoolId = canonicalSchoolIdForUnchangedSlugPolicy(
    descriptor,
    priorManagedBinding,
  );
  const policyIsAuthoritative = !allowUnmanagedFallback || Boolean(priorManagedBinding)
    || descriptor.hasManagedSetup || descriptor.serverManaged;
  const priorFastAuthGateEnabled = fastAuthGateEnabled;
  const priorBindingKey = authGateConfigBindingKey();
  applyManagedSchoolConfig(managedConfig);
  if (policyIsAuthoritative) {
    // A complete authoritative snapshot owns the kill-switch too. Removing
    // the managed key restores its documented default instead of inheriting
    // the last in-memory value from a prior policy.
    fastAuthGateEnabled = descriptor.fastAuthGateEnabled;
    CONFIG.schoolId = descriptor.schoolId || preservedCanonicalSchoolId;
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
  authoritativeManagedSchoolPolicyScope = managedDescriptorSchoolPolicyScope(
    descriptor,
    policyIsAuthoritative,
  );
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
  chrome.alarms.get(LICENSE_CHECK_ALARM, (existing) => {
    if (!existing || Number(existing.periodInMinutes) !== periodInMinutes) {
      chrome.alarms.create(LICENSE_CHECK_ALARM, { periodInMinutes });
    }
  });
}

function clearLicenseStatusRetry() {
  licenseStatusRetryAttempt = 0;
  chrome.alarms.clear(LICENSE_STATUS_RETRY_ALARM);
}

function scheduleLicenseStatusRetry(authContext) {
  try {
    assertAuthenticatedContextCurrent(authContext, 'license retry scheduling');
  } catch {
    return;
  }
  const retryIndex = Math.min(
    licenseStatusRetryAttempt,
    LICENSE_STATUS_RETRY_DELAYS_MS.length - 1,
  );
  const delayMs = LICENSE_STATUS_RETRY_DELAYS_MS[retryIndex];
  licenseStatusRetryAttempt = Math.min(
    licenseStatusRetryAttempt + 1,
    LICENSE_STATUS_RETRY_DELAYS_MS.length,
  );
  chrome.alarms.create(LICENSE_STATUS_RETRY_ALARM, {
    when: Date.now() + delayMs,
  });
}

async function notifyLicenseState(message, authContext) {
  if (authContext) {
    await broadcastToAllTabsForAuth(
      message.type,
      { planStatus: message.planStatus },
      authContext,
      {
        studentId: authContext.studentId,
        studentSessionId: authContext.studentSessionId,
      },
    );
    return;
  }
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

async function disableForInactiveLicense(planStatus, expectedAuthContext = null, options = {}) {
  const authContext = expectedAuthContext || (() => {
    try {
      return captureAuthenticatedContext('license revocation');
    } catch {
      return null;
    }
  })();
  if (!authContext) throw authContextSuperseded('license revocation');
  if (options.authMutationHeld !== true) {
    return enqueueStudentAuthMutation(() => disableForInactiveLicense(
      planStatus,
      authContext,
      { ...options, authMutationHeld: true },
    ));
  }
  const assertCurrent = (reason) => {
    assertAuthenticatedContextCurrent(authContext, reason);
  };
  assertCurrent('license revocation');
  const verifiedAt = Number.isFinite(Number(options.verifiedAt))
    ? Number(options.verifiedAt)
    : Date.now();
  const licenseScope = adoptLicenseState(false, planStatus, authContext, { verifiedAt });
  advanceScreenshotPolicyAuthority();
  screenshotImmediateCapturePending = false;
  clearLicenseStatusRetry();
  try {
    await kv.set({
      licenseActive: false,
      planStatus: licensePlanStatus,
      licenseDisabledAt: verifiedAt,
      [LICENSE_STATE_SCOPE_KEY]: licenseScope,
      [LICENSE_LAST_VERIFIED_AT_KEY]: verifiedAt,
    });
  } catch (error) {
    // An authoritative denial takes effect in memory even when Chrome storage
    // is temporarily unavailable. The recurring status check will repair the
    // durable record after storage recovers.
    console.warn('[License] Failed to persist inactive status:', safeDiagnosticError(error));
  }
  assertCurrent('license revocation persistence');
  // Persist and attempt delivery while the authenticated device context is
  // still available. A retryable failure remains in the bounded outbox and
  // can be delivered after the license/session recovers.
  if (trackingState !== TRACKING_STATES.OFF || persistedMonitoringStateScope !== monitoringEventAuthBindingForContext(authContext)) {
    await transitionTrackingState(TRACKING_STATES.OFF, 'license_inactive', {
      authContext,
      authMutationHeld: true,
    });
    assertCurrent('license revocation tracking transition');
  }
  // Product entitlement revocation must remove teacher-authored controls even
  // after a worker restart. Preserve the independently managed school policy
  // range while clearing classroom, teacher, and temporary rules/state.
  try {
    await clearTeacherSessionStateForSignOut({
      reason: 'entitlement-inactive',
      emitEvent: false,
    });
    assertCurrent('license revocation control cleanup');
    await chrome.alarms.clear(LICENSE_CONTROL_CLEANUP_ALARM);
    assertCurrent('license revocation control cleanup');
  } catch (error) {
    if (isAuthContextCancellation(error)) throw error;
    console.warn('[License] Classroom control cleanup deferred:', safeDiagnosticError(error));
    chrome.alarms.create(LICENSE_CONTROL_CLEANUP_ALARM, {
      when: Date.now() + LICENSE_CONTROL_CLEANUP_RETRY_MS,
    });
  }
  await clearFabAndOverlayState('entitlement-inactive', { closeChat: true }).catch(() => {});
  assertCurrent('license revocation FAB cleanup');
  scheduleHeartbeat(null);
  await disconnectWebSocket({ authContext });
  assertCurrent('license revocation WebSocket cleanup');
  chrome.alarms.clear('ws-reconnect');
  chrome.alarms.clear(HEALTH_CHECK_ALARM_NAME);
  chrome.alarms.clear(CONNECTIVITY_HEALTH_ALARM_NAME);
  chrome.alarms.clear('settings-refresh');
  settingsAlarmScheduled = false;
  await setConnectivityBadge(connectivityStatus());
  assertCurrent('license revocation connectivity state');

  assertCurrent('license revocation persistence');
  await notifyLicenseState(
    { type: 'CLASSPILOT_LICENSE_INACTIVE', planStatus: licensePlanStatus },
    authContext,
  );
  assertCurrent('license revocation notification');
}

function licenseScopeForAuthContext(authContext) {
  return authContext ? authContextProtocolScope(authContext) : null;
}

function licenseStateMatchesAuthContext(authContext) {
  const scope = licenseScopeForAuthContext(authContext);
  return Boolean(scope && licenseStateScope === scope);
}

function currentLicenseIsActive() {
  try {
    const authContext = captureAuthenticatedContext('license state');
    return licenseActive && licenseStateMatchesAuthContext(authContext);
  } catch {
    return false;
  }
}

function resetLicenseStateForAuthorityTransition() {
  licenseActive = false;
  licenseStateScope = null;
  licensePlanStatus = null;
  licenseLastVerifiedAt = 0;
  licenseRefreshState = 'unknown';
  licenseStatusRequestInFlight = null;
  licenseStatusRequestScope = null;
  clearLicenseStatusRetry();
}

function adoptLicenseState(active, planStatus, authContext, options = {}) {
  assertAuthenticatedContextCurrent(authContext, 'license state adoption');
  const scope = licenseScopeForAuthContext(authContext);
  if (!scope) throw authContextSuperseded('license state adoption');
  licenseActive = active === true;
  licenseStateScope = scope;
  licensePlanStatus = typeof planStatus === 'string' ? planStatus.slice(0, 80) : null;
  licenseLastVerifiedAt = Number.isFinite(Number(options.verifiedAt))
    ? Number(options.verifiedAt)
    : Date.now();
  licenseRefreshState = licenseActive ? 'active' : 'denied';
  return scope;
}

async function activateLicenseForAuthenticatedResponse(
  authContext,
  planStatus = null,
  options = {},
) {
  assertAuthenticatedContextCurrent(authContext, 'license activation');
  const wasInactive = !currentLicenseIsActive();
  const verifiedAt = Number.isFinite(Number(options.verifiedAt))
    ? Number(options.verifiedAt)
    : Date.now();
  const licenseScope = adoptLicenseState(true, planStatus, authContext, { verifiedAt });
  clearLicenseStatusRetry();
  await chrome.alarms.clear(LICENSE_CONTROL_CLEANUP_ALARM).catch(() => false);
  assertAuthenticatedContextCurrent(authContext, 'license activation');
  try {
    await kv.set({
      licenseActive: true,
      planStatus: licensePlanStatus,
      [LICENSE_STATE_SCOPE_KEY]: licenseScope,
      [LICENSE_LAST_VERIFIED_AT_KEY]: verifiedAt,
    });
  } catch (error) {
    // Registration/login/status success is already authoritative for this
    // exact auth scope. A local persistence failure must not create a tracking
    // blackout in the current worker.
    console.warn('[License] Failed to persist active status:', safeDiagnosticError(error));
  }
  assertAuthenticatedContextCurrent(authContext, 'license activation persistence');
  if (wasInactive && options.notify !== false) {
    await notifyLicenseState(
      { type: 'CLASSPILOT_LICENSE_ACTIVE', planStatus: licensePlanStatus },
      authContext,
    );
    assertAuthenticatedContextCurrent(authContext, 'license activation notification');
  }
  return wasInactive;
}

function licenseLkgMatchesExactScope(stored, expectedScope) {
  return Boolean(
    stored?.licenseActive === true
    && expectedScope
    && stored?.[LICENSE_STATE_SCOPE_KEY] === expectedScope
  );
}

async function fetchLicenseStatus(authContext) {
  const controller = new AbortController();
  let timedOut = false;
  const onAuthorityAbort = () => controller.abort();
  authContext.signal.addEventListener('abort', onAuthorityAbort, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LICENSE_STATUS_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${authContext.serverOrigin}/api/school/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentToken: authContext.studentToken || null,
        studentEmail: authContext.studentEmail || null,
      }),
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      // The HTTP status itself is an explicit denial even if its optional body
      // is empty, malformed, or stalls. All successful responses must provide
      // a complete strict boolean payload within the same bounded timeout.
      if (response.status !== 402 && response.status !== 403) throw error;
    }
    return { response, data };
  } catch (error) {
    if (timedOut && !authContext.signal.aborted) {
      const timeoutError = new Error('License status request timed out');
      timeoutError.code = 'LICENSE_STATUS_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    authContext.signal.removeEventListener('abort', onAuthorityAbort);
  }
}

async function checkLicenseStatusNow(reason = 'manual', options = {}) {
  let authContext = options.authContext || null;
  if (!authContext) {
    try {
      authContext = captureAuthenticatedContext(`license check:${reason}`);
    } catch (error) {
      if (isAuthContextCancellation(error)) return 'unknown';
      throw error;
    }
  }
  const assertCurrent = () => {
    assertAuthenticatedContextCurrent(authContext, `license check:${reason}`);
    if (options.authMutationGeneration !== undefined) {
      assertAuthMutationBindingCurrent(
        options.authMutationGeneration,
        options.authBinding,
        `license check:${reason}`,
      );
    }
  };
  const applyForCurrentAuth = (mutation) => {
    if (options.authMutationHeld === true) return mutation();
    return enqueueStudentAuthMutation(async () => {
      assertCurrent();
      const result = await mutation();
      assertCurrent();
      return result;
    });
  };
  assertCurrent();
  if (!CONFIG.serverUrl) {
    licenseRefreshState = 'unknown';
    scheduleLicenseStatusRetry(authContext);
    return 'unknown';
  }

  try {
    // License refresh owns its timeout/retry lane. It deliberately bypasses
    // the shared API backoff gate so a telemetry 429 cannot pause entitlement
    // recovery, and a status 429 cannot suppress heartbeats or screenshots.
    const { response, data } = await fetchLicenseStatus(authContext);
    assertCurrent();

    if (response.status === 402 || response.status === 403) {
      await applyForCurrentAuth(() => disableForInactiveLicense(
        data?.planStatus,
        authContext,
        { authMutationHeld: true, verifiedAt: Date.now() },
      ));
      assertCurrent();
      return 'denied';
    }

    if (!response.ok) {
      licenseRefreshState = 'unknown';
      scheduleLicenseStatusRetry(authContext);
      return 'unknown';
    }

    if (!data || typeof data !== 'object' || typeof data.schoolActive !== 'boolean') {
      licenseRefreshState = 'unknown';
      scheduleLicenseStatusRetry(authContext);
      return 'unknown';
    }
    if (data.schoolActive === false) {
      await applyForCurrentAuth(() => disableForInactiveLicense(
        data.planStatus,
        authContext,
        { authMutationHeld: true, verifiedAt: Date.now() },
      ));
      assertCurrent();
      return 'denied';
    }

    const wasInactive = await applyForCurrentAuth(async () => {
      assertCurrent();
      return activateLicenseForAuthenticatedResponse(authContext, data.planStatus, {
        verifiedAt: Date.now(),
        notify: false,
      });
    });
    assertCurrent();
    if (wasInactive) {
      await notifyLicenseState(
        { type: 'CLASSPILOT_LICENSE_ACTIVE', planStatus: data.planStatus },
        authContext,
      );
      assertCurrent();
      if (options.deferTrackingInitialization !== true) {
        initializeAdaptiveTracking(`license-active:${reason}`);
      }
    }
    return 'active';
  } catch (error) {
    if (isAuthContextCancellation(error) || error?.code === 'AUTH_MUTATION_SUPERSEDED') throw error;
    console.warn('[License] Status check failed:', safeDiagnosticError(error));
    licenseRefreshState = 'unknown';
    scheduleLicenseStatusRetry(authContext);
    return 'unknown';
  }
}

async function checkLicenseStatus(reason = 'manual', options = {}) {
  let authContext = options.authContext || null;
  if (!authContext) {
    try {
      authContext = captureAuthenticatedContext(`license check:${reason}`);
    } catch (error) {
      if (isAuthContextCancellation(error)) return 'unknown';
      throw error;
    }
  }
  const requestScope = licenseScopeForAuthContext(authContext);
  if (
    licenseStatusRequestInFlight
    && requestScope
    && licenseStatusRequestScope === requestScope
  ) return licenseStatusRequestInFlight;

  const request = checkLicenseStatusNow(reason, { ...options, authContext });
  licenseStatusRequestInFlight = request;
  licenseStatusRequestScope = requestScope;
  return request.finally(() => {
    if (licenseStatusRequestInFlight === request) {
      licenseStatusRequestInFlight = null;
      licenseStatusRequestScope = null;
    }
  });
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
      console.warn('[Service Worker] Sync config read failed:', safeDiagnosticError(error));
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
    console.warn('[Service Worker] Failed to fetch client config:', safeDiagnosticError(error));
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
    console.warn('[School Hours] Error checking tracking hours:', safeDiagnosticError(error));
    return false;
  }
}

function validSchoolSettingsPayload(value) {
  const structurallyValid = Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.enableTrackingHours === 'boolean'
  );
  if (!structurallyValid) return false;
  if (value.enableTrackingHours !== true) return true;
  return Boolean(
    typeof value.trackingStartTime === 'string'
    && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trackingStartTime)
    && typeof value.trackingEndTime === 'string'
    && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trackingEndTime)
    && typeof value.schoolTimezone === 'string'
    && value.schoolTimezone.trim().length > 0
    && Array.isArray(value.trackingDays)
    && value.trackingDays.length > 0
    && value.trackingDays.every((day) => typeof day === 'string' && day.trim().length > 0)
  );
}

function enqueueSchoolSettingsMutation(operation) {
  const run = () => operation();
  schoolSettingsMutation = schoolSettingsMutation.then(run, run);
  return schoolSettingsMutation;
}

function loadCachedSchoolSettings(options = {}) {
  const authContext = options.authContext || (hasStudentAuth()
    ? captureAuthenticatedContext('school settings cache read')
    : null);
  if (!authContext) return Promise.resolve(null);
  const expectedScope = schoolPolicyScopeForAuthContext(authContext);
  const run = () => enqueueSchoolSettingsMutation(async () => {
    const assertCurrent = () => {
      assertAuthenticatedContextCurrent(authContext, 'school settings cache read');
      if (!expectedScope || schoolPolicyScopeForAuthContext(authContext) !== expectedScope) {
        throw authContextSuperseded('school settings cache read');
      }
    };
    assertCurrent();
    const stored = await kv.get([
      SCHOOL_SETTINGS_CACHE_KEY,
      SCHOOL_SETTINGS_FETCHED_AT_KEY,
      SCHOOL_SETTINGS_SCOPE_KEY,
    ]);
    assertCurrent();
    const storedSettings = stored[SCHOOL_SETTINGS_CACHE_KEY];
    const storedFetchedAt = Number(stored[SCHOOL_SETTINGS_FETCHED_AT_KEY] || 0);
    const storedScope = stored[SCHOOL_SETTINGS_SCOPE_KEY] || null;
    if (storedScope === expectedScope && validSchoolSettingsPayload(storedSettings)) {
      schoolSettings = storedSettings;
      schoolSettingsFetchedAt = storedFetchedAt;
      schoolSettingsScope = expectedScope;
      return schoolSettings;
    }
    schoolSettings = null;
    schoolSettingsFetchedAt = 0;
    schoolSettingsScope = null;
    const latest = await kv.get([
      SCHOOL_SETTINGS_FETCHED_AT_KEY,
      SCHOOL_SETTINGS_SCOPE_KEY,
    ]);
    assertCurrent();
    if (
      (latest[SCHOOL_SETTINGS_SCOPE_KEY] || null) === storedScope
      && Number(latest[SCHOOL_SETTINGS_FETCHED_AT_KEY] || 0) === storedFetchedAt
    ) {
      await kv.remove([
        SCHOOL_SETTINGS_CACHE_KEY,
        SCHOOL_SETTINGS_FETCHED_AT_KEY,
        SCHOOL_SETTINGS_SCOPE_KEY,
      ]);
      assertCurrent();
    }
    return null;
  });
  return options.authMutationHeld === true ? run() : enqueueStudentAuthMutation(run);
}

async function refreshSchoolSettings(options = {}) {
  const force = options.force === true;
  const authContext = options.authContext || (hasStudentAuth()
    ? captureAuthenticatedContext('school settings refresh')
    : null);
  if (!authContext) return null;
  const expectedScope = schoolPolicyScopeForAuthContext(authContext);
  const assertCurrent = () => {
    assertAuthenticatedContextCurrent(authContext, 'school settings refresh');
    if (options.authMutationGeneration !== undefined) {
      assertAuthMutationBindingCurrent(
        options.authMutationGeneration,
        options.authBinding,
        'school settings refresh',
      );
    }
    if (!expectedScope || schoolPolicyScope() !== expectedScope) {
      throw authContextSuperseded('school settings refresh');
    }
  };
  assertCurrent();
  const now = Date.now();
  if (schoolSettingsScope !== expectedScope) {
    schoolSettings = null;
    schoolSettingsFetchedAt = 0;
    schoolSettingsScope = null;
  }
  if (
    !force
    && validSchoolSettingsPayload(schoolSettings)
    && schoolSettingsScope === expectedScope
    && schoolSettingsFetchedAt
    && now - schoolSettingsFetchedAt < SETTINGS_FETCH_INTERVAL_MS
  ) {
    return schoolSettings;
  }

  try {
    // Tracking hours are configured by admins via /api/settings in the ClassPilot admin UI
    // (enableTrackingHours, trackingStartTime, trackingEndTime, trackingDays, schoolTimezone).
    // Requires the "idle" permission in manifest.json to respect ACTIVE/IDLE states.
    // Use /api/extension/settings endpoint which accepts student token authentication
    if (!authContext?.studentToken) {
      console.log('[School Hours] No student token, skipping settings fetch');
      schoolSettings = null;
      schoolSettingsFetchedAt = 0;
      schoolSettingsScope = null;
      return null;
    }
    const authenticatedResponseGuard = captureAuthenticatedResponseGuard();
    const response = await fetchWithBackoff(`${authContext.serverOrigin}/api/extension/settings`, {
      cache: 'no-store',
      headers: {
        'Authorization': `Bearer ${authContext.studentToken}`,
      },
      signal: authContext.signal,
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
    if (!validSchoolSettingsPayload(settings)) {
      throw new Error('School settings payload is incomplete');
    }
    await enqueueStudentAuthMutation(() => enqueueSchoolSettingsMutation(async () => {
      assertCurrent();
      await applyFabSettings(settings.fab || settings, { authContext });
      assertCurrent();
      await kv.set({
        [SCHOOL_SETTINGS_CACHE_KEY]: settings,
        [SCHOOL_SETTINGS_FETCHED_AT_KEY]: now,
        [SCHOOL_SETTINGS_SCOPE_KEY]: expectedScope,
      });
      assertCurrent();
      schoolSettings = settings;
      schoolSettingsFetchedAt = now;
      schoolSettingsScope = expectedScope;
    }));
    console.log('[School Hours] Settings updated');
    return settings;
  } catch (error) {
    if (isAuthContextCancellation(error) || error?.code === 'AUTH_MUTATION_SUPERSEDED') throw error;
    console.warn('[School Hours] Failed to fetch settings:', safeDiagnosticError(error));
    if (
      schoolSettingsScope !== expectedScope
      || !validSchoolSettingsPayload(schoolSettings)
    ) {
      schoolSettings = null;
      schoolSettingsFetchedAt = 0;
      schoolSettingsScope = null;
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
  const code = String(data.code || data.errorCode || '').trim();
  if (/^[A-Z][A-Z0-9_]{0,127}$/.test(code)) error.code = code;
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
  // This value crosses the service-worker/content-script boundary. Keep it
  // exact for the current authenticated generation without echoing the
  // underlying school/student/session/device identifiers into page state.
  if (
    !CONFIG.authContextId
    || !CONFIG.activeStudentId
    || !CONFIG.activeStudentSessionId
    || !CONFIG.deviceId
  ) return null;
  return `v3:${CONFIG.authContextId}`;
}

function exactStudentBinding(raw = {}) {
  const roots = [
    raw,
    raw?.student && typeof raw.student === 'object'
      ? { studentId: raw.student.id ?? raw.student.studentId }
      : null,
    raw?.data,
    raw?.data?.student && typeof raw.data.student === 'object'
      ? { studentId: raw.data.student.id ?? raw.data.student.studentId }
      : null,
    raw?.authority,
    raw?.command,
    raw?.command?.student && typeof raw.command.student === 'object'
      ? { studentId: raw.command.student.id ?? raw.command.student.studentId }
      : null,
    raw?.command?.data,
    raw?.command?.authority,
    raw?.fab,
    raw?.fabState,
    raw?.state,
    raw?.classroomState,
    raw?.settings?.fab,
  ].filter((candidate) => candidate && typeof candidate === 'object');
  const candidates = [];
  const explicitBindingCandidates = [];
  const seen = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
    for (const key of ['binding', 'exactBinding']) {
      if (candidate[key] && typeof candidate[key] === 'object') {
        explicitBindingCandidates.push(candidate[key]);
        pending.push(candidate[key]);
      }
    }
  }
  const conflict = () => {
    const error = new Error('Message contains conflicting exact authority aliases');
    error.code = 'STUDENT_BINDING_MISMATCH';
    throw error;
  };
  for (const bindingCandidate of new Set(explicitBindingCandidates)) {
    if (Number(bindingCandidate.bindingVersion) !== 2) continue;
    const completeString = (key) => (
      Object.prototype.hasOwnProperty.call(bindingCandidate, key)
      && typeof bindingCandidate[key] === 'string'
      && Boolean(bindingCandidate[key].trim())
    );
    if (
      !completeString('schoolId')
      || !completeString('deviceId')
      || !completeString('studentId')
      || !completeString('studentSessionId')
      || !Object.prototype.hasOwnProperty.call(bindingCandidate, 'controlRevision')
      || !Number.isSafeInteger(Number(bindingCandidate.controlRevision))
      || Number(bindingCandidate.controlRevision) < 0
    ) conflict();
  }
  const consistentValue = (key) => {
    let selected = null;
    for (const candidate of candidates) {
      if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
      const supplied = candidate[key];
      if (supplied === null || supplied === undefined || supplied === '') continue;
      if (typeof supplied !== 'string') conflict();
      const value = supplied.trim();
      if (!value) continue;
      if (selected !== null && selected !== value) conflict();
      selected = value;
    }
    return selected;
  };
  const consistentInteger = (keys, sourceCandidates = candidates) => {
    let selected = null;
    for (const key of keys) {
      for (const candidate of sourceCandidates) {
        if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
        const supplied = candidate[key];
        if (supplied === null || supplied === undefined || supplied === '') continue;
        const value = Number(supplied);
        if (!Number.isSafeInteger(value) || value < 0) conflict();
        if (selected !== null && selected !== value) conflict();
        selected = value;
      }
    }
    return selected;
  };
  const firstInteger = (keys, sourceCandidates = candidates) => {
    for (const key of keys) {
      for (const candidate of sourceCandidates) {
        if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
        const supplied = candidate[key];
        if (supplied === null || supplied === undefined || supplied === '') continue;
        const value = Number(supplied);
        if (Number.isSafeInteger(value) && value >= 0) return value;
      }
    }
    return null;
  };
  const revisionKeys = [
    'studentControlRevision',
    'controlRevision',
    'ownershipRevision',
    'studentSessionRevision',
    'sessionRevision',
  ];
  const explicitBindings = [...new Set(explicitBindingCandidates)];
  const explicitV2Bindings = explicitBindings.filter(
    (candidate) => Number(candidate.bindingVersion) === 2,
  );
  let controlRevision = null;
  if (explicitV2Bindings.length > 0) {
    // Settings/auth responses can legitimately contain an older FAB snapshot
    // alongside a newer exact binding. Compare revisions only inside the
    // explicit V2 authority tuple(s), and for actual command envelopes against
    // their duplicate command-level aliases. Identity fields remain globally
    // consistent above because those values may never be spliced.
    controlRevision = consistentInteger(revisionKeys, explicitV2Bindings);
    const isCommandEnvelope = raw?.type === 'remote-control'
      || (raw?.command && typeof raw.command === 'object');
    if (isCommandEnvelope) {
      const commandRevisionCandidates = [
        raw,
        raw?.binding,
        raw?.exactBinding,
        raw?.data,
        raw?.data?.binding,
        raw?.data?.exactBinding,
        raw?.authority,
        raw?.command,
        raw?.command?.binding,
        raw?.command?.exactBinding,
        raw?.command?.data,
        raw?.command?.data?.binding,
        raw?.command?.data?.exactBinding,
        raw?.command?.authority,
      ].filter((candidate) => candidate && typeof candidate === 'object');
      const commandRevision = consistentInteger(revisionKeys, commandRevisionCandidates);
      if (commandRevision !== null && commandRevision !== controlRevision) conflict();
    }
  } else {
    controlRevision = firstInteger(revisionKeys);
  }
  const bindingVersion = explicitBindings.length > 0
    ? consistentInteger(['bindingVersion'], explicitBindings)
    : firstInteger(['bindingVersion']);
  return {
    bindingVersion,
    schoolId: consistentValue('schoolId'),
    deviceId: consistentValue('deviceId'),
    studentId: consistentValue('studentId'),
    studentSessionId: consistentValue('studentSessionId'),
    controlRevision,
  };
}

function schoolPolicyScope(serverOrigin = CONFIG.serverUrl, schoolId = CONFIG.schoolId) {
  const origin = normalizedServerOrigin(serverOrigin);
  const normalizedSchoolId = String(schoolId || '').trim();
  return origin && normalizedSchoolId ? `${origin}|${normalizedSchoolId}` : null;
}

function schoolPolicyScopeForAuthContext(authContext) {
  return schoolPolicyScope(authContext?.serverOrigin, authContext?.schoolId);
}

function managedDescriptorSchoolPolicyScope(descriptor, policyIsAuthoritative) {
  if (
    !policyIsAuthoritative
    || !descriptor?.hasManagedSetup
    || descriptor.schoolIdManaged !== true
    || !descriptor.schoolId
  ) return null;
  const serverOrigin = descriptor.serverManaged
    ? descriptor.serverOrigin
    : normalizedServerOrigin(DEFAULT_SERVER_URL);
  return schoolPolicyScope(serverOrigin, descriptor.schoolId);
}

function classifyStoredSchoolPolicy(
  stored = {},
  expectedScope = schoolPolicyScope(),
  options = {},
) {
  if (!Object.prototype.hasOwnProperty.call(stored, 'globalBlockedDomains')) {
    return { status: 'missing', domains: null, scope: null };
  }
  const storedScope = typeof stored[GLOBAL_BLOCKED_DOMAINS_SCOPE_KEY] === 'string'
    ? stored[GLOBAL_BLOCKED_DOMAINS_SCOPE_KEY]
    : null;
  if (!expectedScope) {
    return { status: 'untrusted', domains: null, scope: storedScope };
  }
  if (storedScope && storedScope !== expectedScope) {
    return { status: 'mismatch', domains: null, scope: storedScope };
  }
  try {
    const domains = RuntimeCore.normalizeDomainList(
      stored.globalBlockedDomains,
      'school block list',
    );
    if (storedScope === expectedScope) {
      return { status: 'matched', domains, scope: expectedScope };
    }
    if (
      authoritativeManagedSchoolPolicyScope === expectedScope
      && options.legacyOwnerScope === expectedScope
    ) {
      return { status: 'legacy_migratable', domains, scope: expectedScope };
    }
    if (
      authoritativeManagedSchoolPolicyScope === expectedScope
      && options.legacyOwnerScope
      && options.legacyOwnerScope !== expectedScope
    ) {
      return { status: 'mismatch', domains: null, scope: options.legacyOwnerScope };
    }
    // 2.7.0 stored the block list without a school/origin scope. Until an
    // authoritative managed tuple proves ownership, leave the surviving DNR
    // range untouched instead of deleting restrictions or guessing a tenant.
    return { status: 'legacy_untrusted', domains: null, scope: null };
  } catch {
    return { status: 'invalid', domains: null, scope: storedScope };
  }
}

function resetStudentControlRevisionAuthority() {
  studentControlRevisionAuthority = Object.freeze({
    scope: null,
    revision: null,
  });
}

const AUTH_BOUND_NOTIFICATION_API_TIMEOUT_MS = 1_000;
const AUTH_BOUND_NOTIFICATION_RETRY_MS = 5_000;
const AUTH_BOUND_NOTIFICATION_CLEANUP_ALARM = 'auth-bound-notification-cleanup';

function scheduleAuthBoundNotificationCleanupRetry(delayMs = AUTH_BOUND_NOTIFICATION_RETRY_MS) {
  const when = Date.now() + Math.max(1000, Number(delayMs || 0));
  chrome.alarms?.get?.(AUTH_BOUND_NOTIFICATION_CLEANUP_ALARM, (existing) => {
    if (!existing || Number(existing.scheduledTime || 0) > when) {
      chrome.alarms.create(AUTH_BOUND_NOTIFICATION_CLEANUP_ALARM, { when });
    }
  });
}

function clearAuthBoundNotificationCleanupRetry() {
  try {
    const pending = chrome.alarms?.clear?.(AUTH_BOUND_NOTIFICATION_CLEANUP_ALARM);
    Promise.resolve(pending).catch(() => {});
  } catch {
    // A future worker wake always performs another inventory reconciliation.
  }
}

function readAllNotificationsBounded() {
  return new Promise((resolve) => {
    if (!chrome.notifications?.getAll) {
      resolve({ ok: false, notifications: {} });
      return;
    }
    let settled = false;
    const finish = (ok, notifications = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve({
        ok: ok === true,
        notifications: notifications && typeof notifications === 'object' ? notifications : {},
      });
    };
    const timeoutId = setTimeout(
      () => finish(false, {}),
      AUTH_BOUND_NOTIFICATION_API_TIMEOUT_MS,
    );
    try {
      const pending = chrome.notifications.getAll((notifications) => {
        const failed = Boolean(chrome.runtime?.lastError);
        finish(!failed, notifications);
      });
      if (pending && typeof pending.then === 'function') {
        pending.then(
          (notifications) => finish(true, notifications),
          () => finish(false, {}),
        );
      }
    } catch {
      finish(false, {});
    }
  });
}

function clearAuthBoundNotificationOutcome(notificationId) {
  return new Promise((resolve) => {
    if (!chrome.notifications?.clear) {
      resolve({ ok: false, cleared: false });
      return;
    }
    let settled = false;
    const finish = (ok, cleared = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve({ ok: ok === true, cleared: cleared === true });
    };
    const timeoutId = setTimeout(
      () => finish(false, false),
      AUTH_BOUND_NOTIFICATION_API_TIMEOUT_MS,
    );
    try {
      const pending = chrome.notifications.clear(notificationId, (cleared) => {
        const failed = Boolean(chrome.runtime?.lastError);
        finish(!failed, cleared);
      });
      if (pending && typeof pending.then === 'function') {
        pending.then(
          (cleared) => finish(true, cleared),
          () => finish(false, false),
        );
      }
    } catch {
      finish(false, false);
    }
  });
}

async function clearAuthBoundNotification(notificationId) {
  const outcome = await clearAuthBoundNotificationOutcome(notificationId);
  return outcome.ok && outcome.cleared;
}

function authBoundNotificationPrefixForContext(authContext) {
  const authContextId = String(authContext?.authContextId || '')
    .replace(/[^a-zA-Z0-9_-]/g, '');
  return authContextId ? `classpilot-message-${authContextId}-` : null;
}

function currentAuthBoundNotificationPrefix() {
  try {
    return authBoundNotificationPrefixForContext(
      captureAuthenticatedContext('notification inventory ownership'),
    );
  } catch {
    return null;
  }
}

async function reconcileAuthBoundTeacherMessageNotifications(options = {}) {
  const readInventory = options.readInventory || readAllNotificationsBounded;
  const clearNotification = options.clearNotification || clearAuthBoundNotificationOutcome;
  const ownerGeneration = options.ownerGeneration === undefined
    ? studentAuthMutationGeneration
    : options.ownerGeneration;
  const preservedPrefix = options.preservedPrefix === undefined
    ? currentAuthBoundNotificationPrefix()
    : options.preservedPrefix;
  const ownerIsCurrent = () => (
    studentAuthMutationGeneration === ownerGeneration
    && currentAuthBoundNotificationPrefix() === preservedPrefix
  );
  if (!ownerIsCurrent()) return false;
  const firstInventory = await readInventory();
  if (!firstInventory?.ok || !ownerIsCurrent()) return false;
  // On an authenticated worker, notifications carrying the current exact
  // context are still valid UI and must survive a retired-context retry/alarm.
  // A cold signed-out worker has no trusted prefix, so it safely clears every
  // extension-owned teacher notification left by an unknown prior context.
  const extensionIds = Object.keys(firstInventory.notifications || {})
    .filter((notificationId) => notificationId.startsWith('classpilot-message-'));
  const ids = extensionIds.filter((notificationId) => (
    !preservedPrefix || !notificationId.startsWith(preservedPrefix)
  ));
  await Promise.all(ids.map((notificationId) => (
    clearNotification(notificationId).catch(() => ({ ok: false, cleared: false }))
  )));
  const verification = await readInventory();
  if (!ownerIsCurrent()) return false;
  const reconciled = Boolean(
    verification?.ok
    && !ids.some((notificationId) => (
      Object.prototype.hasOwnProperty.call(verification.notifications || {}, notificationId)
    )),
  );
  if (!reconciled) return false;
  // Reconstruct the in-memory owner set on every successful pass so an MV3
  // restart can later force a cleanup when this exact identity retires.
  activeAuthBoundNotificationIds.clear();
  if (preservedPrefix) {
    for (const notificationId of Object.keys(verification.notifications || {})) {
      if (notificationId.startsWith(preservedPrefix)) {
        activeAuthBoundNotificationIds.add(notificationId);
      }
    }
  }
  return true;
}

function ensureAuthBoundNotificationInventory(options = {}) {
  const force = options.force === true;
  if (authBoundNotificationInventoryReconciled && !force) return Promise.resolve(true);
  const runReconciliation = () => reconcileAuthBoundTeacherMessageNotifications(options)
    .then((reconciled) => {
      authBoundNotificationInventoryReconciled = reconciled === true;
      authBoundNotificationCleanupRetryAt = reconciled
        ? 0
        : Date.now() + AUTH_BOUND_NOTIFICATION_RETRY_MS;
      if (reconciled) {
        clearAuthBoundNotificationCleanupRetry();
      } else {
        scheduleAuthBoundNotificationCleanupRetry();
      }
      return authBoundNotificationInventoryReconciled;
    })
    .catch(() => {
      authBoundNotificationInventoryReconciled = false;
      authBoundNotificationCleanupRetryAt = Date.now() + AUTH_BOUND_NOTIFICATION_RETRY_MS;
      scheduleAuthBoundNotificationCleanupRetry();
      return false;
    });
  const trackReconciliation = (pending) => {
    let tracked;
    tracked = Promise.resolve(pending).finally(() => {
      if (authBoundNotificationCleanupInFlight === tracked) {
        authBoundNotificationCleanupInFlight = null;
      }
    });
    authBoundNotificationCleanupInFlight = tracked;
    authBoundNotificationCleanupPromise = tracked;
    return tracked;
  };
  if (authBoundNotificationCleanupInFlight) {
    if (!force) return authBoundNotificationCleanupInFlight;
    const priorReconciliation = authBoundNotificationCleanupInFlight;
    // A forced pass is requested after a specific notification clear failed.
    // It must observe state *after* the older inventory snapshot finishes;
    // merely joining that snapshot can miss a notification created mid-race.
    return trackReconciliation(
      priorReconciliation.catch(() => false).then(() => {
        authBoundNotificationInventoryReconciled = false;
        return runReconciliation();
      }),
    );
  }
  const now = Date.now();
  if (!force && now < authBoundNotificationCleanupRetryAt) {
    return Promise.resolve(false);
  }
  return trackReconciliation(runReconciliation());
}

async function clearAllAuthBoundTeacherMessageNotifications(options = {}) {
  authBoundNotificationInventoryReconciled = false;
  authBoundNotificationCleanupRetryAt = 0;
  return ensureAuthBoundNotificationInventory({ ...options, force: true });
}

function handleAuthBoundNotificationCleanupAlarm() {
  authBoundNotificationInventoryReconciled = false;
  authBoundNotificationCleanupRetryAt = 0;
  authBoundNotificationCleanupPromise = ensureAuthBoundNotificationInventory({ force: true });
  return authBoundNotificationCleanupPromise;
}

function observeStudentControlRevision(rawRevision, authContext = null, reason = 'control revision') {
  const revision = Number(rawRevision);
  if (!Number.isSafeInteger(revision) || revision < 0) return currentStudentControlRevision();
  const context = authContext || captureAuthenticatedContext(reason);
  assertAuthenticatedContextCurrent(context, reason);
  const scope = authContextProtocolScope(context);
  const priorRevision = studentControlRevisionAuthority.scope === scope
    ? studentControlRevisionAuthority.revision
    : null;
  const nextRevision = Number.isSafeInteger(priorRevision)
    ? Math.max(priorRevision, revision)
    : revision;
  studentControlRevisionAuthority = Object.freeze({ scope, revision: nextRevision });
  return nextRevision;
}

function observeExactStudentControlRevision(raw, authContext = null, reason = 'exact control revision') {
  const binding = exactStudentBinding(raw);
  if (binding.bindingVersion !== 2) return currentStudentControlRevision();
  const context = authContext || captureAuthenticatedContext(reason);
  assertAuthenticatedContextCurrent(context, reason);
  if (
    binding.schoolId !== context.schoolId
    || binding.deviceId !== context.deviceId
    || binding.studentId !== context.studentId
    || binding.studentSessionId !== context.studentSessionId
    || !Number.isSafeInteger(binding.controlRevision)
    || binding.controlRevision < 0
  ) {
    const error = new Error(`${reason} does not match the immutable authentication context`);
    error.code = 'STUDENT_BINDING_MISMATCH';
    throw error;
  }
  return observeStudentControlRevision(binding.controlRevision, context, reason);
}

function currentStudentControlRevision() {
  let context;
  try {
    context = captureAuthenticatedContext('control revision');
  } catch {
    return null;
  }
  const scope = authContextProtocolScope(context);
  if (studentControlRevisionAuthority.scope !== scope) return null;
  const revision = Number(studentControlRevisionAuthority.revision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function assertCurrentStudentBinding(raw = {}, label = 'message', options = {}) {
  const binding = exactStudentBinding(raw);
  const context = options.authContext || null;
  // Full authority is capability-specific. Ordinary commands, chat, FAB and
  // lifecycle frames retain their established exact student/session check;
  // callers opt in only for the operation governed by a negotiated V2
  // capability (for example an ACK or an exact-reference tab close).
  const requireFullAuthority = options.requireFullAuthority === true;
  const expectedSchoolId = context?.schoolId ?? (String(CONFIG.schoolId || '').trim() || null);
  const expectedDeviceId = context?.deviceId ?? CONFIG.deviceId;
  const expectedControlRevision = currentStudentControlRevision();
  if (
    studentAuthInvalidating
    || !CONFIG.activeStudentId
    || !CONFIG.activeStudentSessionId
    || binding.studentId !== CONFIG.activeStudentId
    || binding.studentSessionId !== CONFIG.activeStudentSessionId
    || (requireFullAuthority && (
      binding.bindingVersion !== 2
      || !expectedSchoolId
      || binding.schoolId !== expectedSchoolId
      || !expectedDeviceId
      || binding.deviceId !== expectedDeviceId
      || binding.controlRevision === null
      || expectedControlRevision === null
      || binding.controlRevision !== expectedControlRevision
    ))
  ) {
    const error = new Error(`${label} belongs to a retired student session`);
    error.code = 'STUDENT_BINDING_MISMATCH';
    throw error;
  }
  return binding;
}

function acceptsCurrentStudentBinding(raw = {}, label = 'message', options = {}) {
  try {
    assertCurrentStudentBinding(raw, label, options);
    return true;
  } catch (error) {
    console.warn(`[Binding] Ignoring ${label}:`, safeDiagnosticError(error));
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
    raw.schoolId || raw.exactBinding?.schoolId || raw.settings?.schoolId || raw.school?.id || ''
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
  // Exact student bindings are browser-session authority for every auth kind.
  // Dispatch the local marker removal before awaiting session storage. A
  // later clear writes `true` afterward and therefore remains fail-closed.
  const markerCleared = durableLocalKv.remove(STUDENT_AUTH_INVALIDATING_KEY);
  const configPersisted = persistedConfig
    ? durableLocalKv.set({ config: persistedConfig })
    : Promise.resolve();
  await setManualAuthState(update);
  await Promise.all([markerCleared, configPersisted]);
  assertAuthMutationCurrent(mutationGeneration, reason);
  assertAuthenticatedResponseGuardCurrent(responseGuard, reason);
  CONFIG.activeStudentId = binding.studentId;
  CONFIG.activeStudentSessionId = binding.studentSessionId;
  if (authenticatedSchoolId) CONFIG.schoolId = authenticatedSchoolId;
  studentAuthInvalidating = false;
  const adoptedAuthContext = captureAuthenticatedContext(`${reason} storage adoption`);
  await cleanupRetiredExactBoundStorage(adoptedAuthContext, `${reason} storage adoption`);
  assertAuthMutationCurrent(mutationGeneration, reason);
  assertAuthenticatedResponseGuardCurrent(responseGuard, reason);
  if (trackingState !== TRACKING_STATES.OFF) connectWebSocket().catch(() => {});
  if (binding.bindingVersion === 2) {
    observeExactStudentControlRevision(raw, adoptedAuthContext, `${reason} control revision`);
  }
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
  await notifyStudentMessageStateCleared(reason);
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
  const authContext = options.authContext || (() => {
    try {
      return captureAuthenticatedContext('FAB state');
    } catch {
      return null;
    }
  })();
  const assertCurrent = (reason = 'FAB state') => {
    if (authContext) assertAuthenticatedContextCurrent(authContext, reason);
  };
  const rawBinding = exactStudentBinding(rawFabState);
  if (rawBinding.studentId || rawBinding.studentSessionId) {
    assertCurrentStudentBinding(rawFabState, 'FAB state', { authContext });
  }
  assertCurrent();
  const stored = await kv.get([
    FAB_STATE_STORAGE_KEY,
    FAB_CONTEXT_STORAGE_KEY,
    FAB_CHAT_CONTEXT_STORAGE_KEY,
  ]);
  assertCurrent();
  if (rawBinding.studentId || rawBinding.studentSessionId) {
    assertCurrentStudentBinding(rawFabState, 'FAB state', { authContext });
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
  assertCurrent();
  await kv.set(updates);
  assertCurrent();
  currentFabState = nextState;
  const authorityEnvelope = options.authorityEnvelope || rawFabState;
  const broadcastSource = (() => {
    if (!authContext) return authorityEnvelope;
    const authorityBinding = exactStudentBinding(authorityEnvelope);
    return authorityBinding.studentId && authorityBinding.studentSessionId
      ? authorityEnvelope
      : browserPolicyEnvelopeForAuth(authContext);
  })();
  if (authContext) {
    const authorityBinding = exactStudentBinding(authorityEnvelope);
    if (authorityBinding.bindingVersion === 2) {
      observeExactStudentControlRevision(
        authorityEnvelope,
        authContext,
        'FAB control revision',
      );
    }
  }
  if (lifecycleChanged) {
    await clearClassroomOverlayState(`fab:${nextState.reason || 'lifecycle-change'}`, {
      authContext,
      sourceMessage: broadcastSource,
      expectedBinding: binding,
    });
    assertCurrent('FAB lifecycle overlay clear');
  }
  if (options.broadcast !== false) {
    if (authContext) {
      await broadcastToAllTabsForAuth(
        'fab-state',
        { ...nextState, context },
        authContext,
        broadcastSource,
      );
      assertCurrent('FAB state broadcast');
    } else {
      await broadcastToAllTabs('fab-state', { ...nextState, context });
    }
  }
  return nextState;
}

function applyFabSettings(rawFabState, options = {}) {
  let authContext = options.authContext || null;
  if (!authContext) {
    try {
      authContext = captureAuthenticatedContext('FAB state reservation');
    } catch {
      authContext = null;
    }
  }
  const expectedBinding = fabIdentityBinding();
  return enqueueFabStateMutation(async () => {
    if (authContext) assertAuthenticatedContextCurrent(authContext, 'FAB state reservation');
    if (expectedBinding !== fabIdentityBinding()) throw authContextSuperseded('FAB state reservation');
    const result = await applyFabSettingsNow(rawFabState, { ...options, authContext });
    if (authContext) assertAuthenticatedContextCurrent(authContext, 'FAB state reservation');
    if (expectedBinding !== fabIdentityBinding()) throw authContextSuperseded('FAB state reservation');
    return result;
  });
}

async function updateLocalFabHandRaised(handRaised, reason, options = {}) {
  const authContext = options.authContext || captureAuthenticatedContext(reason);
  assertAuthenticatedContextCurrent(authContext, reason);
  const expectedBinding = fabIdentityBinding();
  if (!currentFabState) {
    const sessionIds = activeTeachingSessionIds();
    const teachingSessionId = String(currentClassroomState?.teachingSessionId || '').trim();
    if (!expectedBinding || !teachingSessionId || !sessionIds.includes(teachingSessionId)) {
      throw authContextSuperseded(reason);
    }
    await applyFabSettings({
      schemaVersion: 1,
      revision: Number(currentClassroomState?.revision || 0),
      activeSessionIds: sessionIds,
      teachingSessionId,
      handRaised: handRaised === true,
      reason,
    }, { authContext });
    assertAuthenticatedContextCurrent(authContext, reason);
    if (expectedBinding !== fabIdentityBinding()) throw authContextSuperseded(reason);
    return;
  }
  await applyFabSettings({
    ...currentFabState,
    handRaised: handRaised === true,
    reason,
  }, { authContext });
  assertAuthenticatedContextCurrent(authContext, reason);
}

let classroomOverlayMutation = Promise.resolve();

function activeTeachingSessionIds() {
  const fabSessions = normalizeIdList(currentFabState?.activeSessionIds);
  const classroomSessions = normalizeIdList(currentClassroomState?.teachingSessionId
    ? [currentClassroomState.teachingSessionId]
    : []);
  if (!currentFabState) return classroomSessions;
  if (currentFabState.ownershipRevisionKnown === true) {
    const fabRevision = Number(currentFabState.ownershipRevision || 0);
    const classroomRevision = Number(currentClassroomState?.revision || 0);
    return fabRevision >= classroomRevision ? fabSessions : classroomSessions;
  }
  return fabSessions.length > 0 ? fabSessions : classroomSessions;
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

function mutateClassroomOverlayState(operation, options = {}) {
  let authContext = options.authContext || null;
  if (!authContext) {
    try {
      authContext = captureAuthenticatedContext('classroom overlay reservation');
    } catch {
      authContext = null;
    }
  }
  const expectedBinding = fabIdentityBinding();
  classroomOverlayMutation = classroomOverlayMutation.then(async () => {
    if (authContext) assertAuthenticatedContextCurrent(authContext, 'classroom overlay mutation');
    if (expectedBinding !== fabIdentityBinding()) {
      throw authContextSuperseded('classroom overlay mutation');
    }
    const binding = expectedBinding;
    const stored = await kv.get(CLASSROOM_OVERLAY_STORAGE_KEY);
    if (authContext) assertAuthenticatedContextCurrent(authContext, 'classroom overlay mutation');
    if (expectedBinding !== fabIdentityBinding()) {
      throw authContextSuperseded('classroom overlay mutation');
    }
    const prior = stored[CLASSROOM_OVERLAY_STORAGE_KEY];
    const state = prior?.binding === binding
      ? prior
      : { schemaVersion: 1, binding, timer: null, poll: null, updatedAt: Date.now() };
    const next = await operation(state, binding);
    if (authContext) assertAuthenticatedContextCurrent(authContext, 'classroom overlay mutation');
    if (expectedBinding !== fabIdentityBinding()) {
      throw authContextSuperseded('classroom overlay mutation');
    }
    await kv.set({ [CLASSROOM_OVERLAY_STORAGE_KEY]: next });
    if (authContext) assertAuthenticatedContextCurrent(authContext, 'classroom overlay mutation');
    if (expectedBinding !== fabIdentityBinding()) {
      throw authContextSuperseded('classroom overlay mutation');
    }
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
  }, { authContext: executionContext.authContext });
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
  }, { authContext: executionContext.authContext });
}

async function clearClassroomOverlayState(reason = 'cleared', options = {}) {
  const authContext = options.authContext || null;
  const expectedBinding = options.expectedBinding
    || (authContext ? fabIdentityBinding() : null);
  const sourceMessage = options.sourceMessage
    || (authContext ? browserPolicyEnvelopeForAuth(authContext) : null);
  const assertCurrent = (label = 'classroom overlay clear') => {
    if (!authContext) return;
    assertAuthenticatedContextCurrent(authContext, label);
    if (!expectedBinding || fabIdentityBinding() !== expectedBinding) {
      throw authContextSuperseded(label);
    }
    const binding = assertCurrentStudentBinding(sourceMessage, label, { authContext });
    assertBindingMatchesAuthContext(binding, authContext, label);
  };
  const clearOperation = async () => {
    assertCurrent();
    await chrome.alarms.clear(CLASSROOM_OVERLAY_EXPIRY_ALARM);
    assertCurrent();
    await kv.set({ [CLASSROOM_OVERLAY_STORAGE_KEY]: null });
    assertCurrent();
  };
  classroomOverlayMutation = classroomOverlayMutation.then(clearOperation, clearOperation);
  await classroomOverlayMutation;
  assertCurrent();
  if (authContext) {
    await broadcastToAllTabsForAuth(
      'timer',
      { action: 'stop', reason },
      authContext,
      sourceMessage,
    );
    assertCurrent();
    await broadcastToAllTabsForAuth(
      'poll',
      { action: 'close', reason },
      authContext,
      sourceMessage,
    );
    assertCurrent();
  } else {
    await broadcastToAllTabs('timer', { action: 'stop', reason });
    await broadcastToAllTabs('poll', { action: 'close', reason });
  }
}

function getRestorableClassroomOverlayState(options = {}) {
  const authContext = options.authContext
    || captureAuthenticatedContext('classroom overlay read');
  const expectedBinding = options.expectedBinding || fabIdentityBinding();
  return enqueueStudentAuthMutation(async () => {
    const operation = async () => {
      const assertCurrent = (reason = 'classroom overlay read') => {
        assertAuthenticatedContextCurrent(authContext, reason);
        if (!expectedBinding || fabIdentityBinding() !== expectedBinding) {
          throw authContextSuperseded(reason);
        }
      };
      assertCurrent();
      const stored = await kv.get(CLASSROOM_OVERLAY_STORAGE_KEY);
      assertCurrent();
      const state = stored[CLASSROOM_OVERLAY_STORAGE_KEY];
      if (state?.binding !== expectedBinding) {
        if (state) {
          const latest = (await kv.get(CLASSROOM_OVERLAY_STORAGE_KEY))[CLASSROOM_OVERLAY_STORAGE_KEY];
          assertCurrent();
          if (
            latest?.binding === state.binding
            && Number(latest?.updatedAt || 0) === Number(state.updatedAt || 0)
          ) {
            await kv.set({ [CLASSROOM_OVERLAY_STORAGE_KEY]: null });
            assertCurrent();
          }
        }
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
        assertCurrent();
        scheduleClassroomOverlayExpiry(next);
      }
      return { timer, poll };
    };
    classroomOverlayMutation = classroomOverlayMutation.then(operation, operation);
    return classroomOverlayMutation;
  });
}

async function getClassroomUiSnapshotForAuth(authContext, reason = 'classroom UI snapshot') {
  assertAuthenticatedContextCurrent(authContext, reason);
  await Promise.all([
    classroomStateRestorePromise,
    classroomOverlayMutation.catch(() => undefined),
    fabStateMutation.catch(() => undefined),
  ]);
  assertAuthenticatedContextCurrent(authContext, reason);
  const stored = await kv.get([
    CLASSROOM_OVERLAY_STORAGE_KEY,
    FAB_STATE_STORAGE_KEY,
    FAB_CONTEXT_STORAGE_KEY,
  ]);
  assertAuthenticatedContextCurrent(authContext, reason);
  const expectedFabBinding = fabIdentityBinding();
  const storedFabContext = stored[FAB_CONTEXT_STORAGE_KEY] || null;
  const fabContext = expectedFabBinding && storedFabContext?.binding === expectedFabBinding
    ? storedFabContext
    : null;
  const fabState = fabContext
    ? (stored[FAB_STATE_STORAGE_KEY] || currentFabState)
    : currentFabState;
  const storedOverlay = stored[CLASSROOM_OVERLAY_STORAGE_KEY];
  const now = Date.now();
  const activeSessions = activeTeachingSessionIds();
  const overlayCurrent = expectedFabBinding && storedOverlay?.binding === expectedFabBinding;
  const sessionMatches = (overlay) => !overlay?.teachingSessionId
    || activeSessions.includes(overlay.teachingSessionId);
  const overlays = {
    timer: overlayCurrent
      && Number(storedOverlay.timer?.endsAt || 0) > now
      && sessionMatches(storedOverlay.timer)
      ? storedOverlay.timer
      : null,
    poll: overlayCurrent
      && !storedOverlay.poll?.response
      && Number(storedOverlay.poll?.expiresAt || 0) > now
      && sessionMatches(storedOverlay.poll)
      ? storedOverlay.poll
      : null,
  };
  return {
    classroomState: currentClassroomState,
    overlays,
    fabState,
    fabContext,
    fabBinding: expectedFabBinding,
    studentMessageContext: studentMessageContextFor(authContext),
  };
}

async function replayClassroomUiForAuth(authContext, reason = 'classroom UI replay') {
  const snapshot = await getClassroomUiSnapshotForAuth(authContext, reason);
  assertAuthenticatedContextCurrent(authContext, reason);
  const sourceMessage = {
    studentId: authContext.studentId,
    studentSessionId: authContext.studentSessionId,
  };
  await broadcastToAllTabsForAuth(
    'classroom-overlay-state-sync',
    snapshot,
    authContext,
    sourceMessage,
  );
  assertAuthenticatedContextCurrent(authContext, reason);
  return snapshot;
}

async function expireClassroomOverlays(options = {}) {
  let authContext = options.authContext || null;
  if (!authContext) {
    try {
      authContext = captureAuthenticatedContext('classroom overlay expiry');
    } catch {
      authContext = null;
    }
  }
  let timerExpired = false;
  let pollExpired = false;
  await mutateClassroomOverlayState(async (state) => {
    const now = Date.now();
    timerExpired = Boolean(state.timer && Number(state.timer.endsAt) + 5000 <= now);
    pollExpired = Boolean(state.poll && Number(state.poll.expiresAt) <= now);
    return {
      ...state,
      timer: timerExpired ? null : state.timer,
      poll: pollExpired ? null : state.poll,
      updatedAt: now,
    };
  }, { authContext });
  if (authContext) {
    assertAuthenticatedContextCurrent(authContext, 'classroom overlay expiry broadcast');
    const sourceMessage = browserPolicyEnvelopeForAuth(authContext);
    if (timerExpired) {
      await broadcastToAllTabsForAuth(
        'timer',
        { action: 'stop', reason: 'expired' },
        authContext,
        sourceMessage,
      );
    }
    assertAuthenticatedContextCurrent(authContext, 'classroom overlay expiry broadcast');
    if (pollExpired) {
      await broadcastToAllTabsForAuth(
        'poll',
        { action: 'close', reason: 'expired' },
        authContext,
        sourceMessage,
      );
    }
    assertAuthenticatedContextCurrent(authContext, 'classroom overlay expiry broadcast');
  } else {
    if (timerExpired) await broadcastToAllTabs('timer', { action: 'stop', reason: 'expired' });
    if (pollExpired) await broadcastToAllTabs('poll', { action: 'close', reason: 'expired' });
  }
}

function markPollResponsePersisted(pollId, selectedOption, authContext = null) {
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

async function sendChatDeliveryAck(message, deliveryStatus, errorMessage, expectedAuthContext) {
  const messageId = message.chatMessageId || message.messageId;
  if (!messageId || !expectedAuthContext) return false;
  assertAuthenticatedContextCurrent(expectedAuthContext, 'chat delivery acknowledgement');
  const binding = assertCurrentStudentBinding(message, 'chat delivery acknowledgement');
  assertBindingMatchesAuthContext(binding, expectedAuthContext, 'chat delivery acknowledgement');
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
  await enqueueChatAck(ack, expectedAuthContext);
  assertAuthenticatedContextCurrent(expectedAuthContext, 'chat delivery acknowledgement');
  await wsSend(ack, expectedAuthContext);
  scheduleChatAckFlush();
  return true;
}

function determineTrackingState() {
  let expectedScope = null;
  try {
    expectedScope = schoolPolicyScopeForAuthContext(
      captureAuthenticatedContext('tracking settings decision'),
    );
  } catch {
    expectedScope = null;
  }
  if (
    !expectedScope
    || schoolSettingsScope !== expectedScope
    || !validSchoolSettingsPayload(schoolSettings)
  ) {
    isScheduleHardOff = true;
    return TRACKING_STATES.OFF;
  }
  const effectiveSettings = schoolSettings;
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

function disconnectWebSocket(options = {}) {
  const assertInitiatorCurrent = () => {
    if (options.authContext) {
      assertAuthenticatedContextCurrent(options.authContext, 'WebSocket disconnect');
    } else if (options.authMutationGeneration !== undefined) {
      assertAuthMutationCurrent(options.authMutationGeneration, 'WebSocket disconnect');
    }
  };
  assertInitiatorCurrent();
  chrome.alarms.clear('ws-reconnect');
  const broadcastCleanupPromise = cleanupTeacherBroadcast('websocket-disconnect', {
    notifyTeacher: false,
    authContext: options.authContext || null,
    sourceMessage: options.authContext
      ? browserPolicyEnvelopeForAuth(options.authContext)
      : null,
  });
  const closingLiveViewContext = activeLiveViewContext;
  const closingLiveViewNegotiationId = activeLiveViewNegotiationId;
  const closingLiveViewTeachingSessionId = activeLiveViewTeachingSessionId;
  const hadActiveLiveView = Boolean(closingLiveViewNegotiationId);
  if (hadActiveLiveView) {
    setObservedState(false, 'websocket-disconnect');
  }
  wsConnected = false;
  wsTransportConnected = false;
  wsAuthenticatedGeneration = 0;
  const closingIdentity = wsTransportIdentity;
  assertInitiatorCurrent();
  // Tell offscreen document to close the WebSocket
  const closePromise = sendToOffscreen({
    type: 'WS_CLOSE',
    connectionGeneration: closingIdentity?.connectionGeneration || wsConnectionGeneration,
    authContextId: closingIdentity?.authContextId,
    serverOrigin: closingIdentity?.serverOrigin,
  }).then((response) => {
    // A WS_CLOSE can resolve after a replacement socket has authenticated and
    // started a different exact Live View. Only retire the tuple that this
    // close operation captured; never orphan a newer stream by erasing its
    // worker-side stop authority.
    if (
      activeLiveViewContext === closingLiveViewContext
      && activeLiveViewNegotiationId === closingLiveViewNegotiationId
      && activeLiveViewTeachingSessionId === closingLiveViewTeachingSessionId
    ) {
      activeLiveViewNegotiationId = null;
      activeLiveViewTeachingSessionId = null;
      activeLiveViewContext = null;
    }
    return response;
  }).catch(async () => {
    const replacementTransportExists = Boolean(
      wsTransportIdentity && wsTransportIdentity !== closingIdentity
    );
    const replacementLiveViewExists = Boolean(
      activeLiveViewContext && activeLiveViewContext !== closingLiveViewContext
    );
    if (replacementTransportExists || replacementLiveViewExists) return;
    if (activeLiveViewContext === closingLiveViewContext) {
      activeLiveViewNegotiationId = null;
      activeLiveViewTeachingSessionId = null;
      activeLiveViewContext = null;
    }
    if (wsTransportIdentity === closingIdentity) wsTransportIdentity = null;
    // A rejected WS_CLOSE is not evidence that offscreen stopped its socket or
    // MediaStream. Close the document fail-private while this captured owner
    // is still current. Replacement creation waits for this close flight.
    await closeOffscreenDocumentFailPrivate();
  }).finally(() => {
    if (wsTransportIdentity === closingIdentity) wsTransportIdentity = null;
  });
  if (ws) {
    try {
      ws.close();
    } catch (error) {
      console.warn('WebSocket close failed:', safeDiagnosticError(error));
    }
  }
  ws = null;
  return Promise.all([closePromise, broadcastCleanupPromise]).then(([response]) => response);
}

function scheduleHeartbeat(periodInMinutes) {
  if (!periodInMinutes) {
    chrome.alarms.get('heartbeat', (existing) => {
      if (existing) chrome.alarms.clear('heartbeat');
    });
    if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
    if (eventHeartbeatTimer) clearTimeout(eventHeartbeatTimer);
    eventHeartbeatTimer = null;
    eventHeartbeatReason = null;
    lastHeartbeatDispatchAt = 0;
    return;
  }

  const normalizedPeriod = Math.max(0.5, Number(periodInMinutes) || 0.5);
  const intervalWasMissing = !heartbeatIntervalId;
  if (intervalWasMissing) {
    heartbeatIntervalId = setInterval(() => {
      safeSendHeartbeat('interval');
    }, HEARTBEAT_INTERVAL_MS);
  }
  // Chrome alarms survive MV3 suspension. Preserve an unchanged recovery
  // alarm rather than shifting its schedule on every reconciliation.
  chrome.alarms.get('heartbeat', (existing) => {
    if (!existing || Number(existing.periodInMinutes) !== normalizedPeriod) {
      chrome.alarms.create('heartbeat', { periodInMinutes: normalizedPeriod });
    }
  });
  if (intervalWasMissing) {
    safeSendHeartbeat('schedule');
    console.log('[Heartbeat] Scheduled every 10 seconds');
  }
}

function clearNetworkAlarms() {
  chrome.alarms.clear('settings-refresh');
  chrome.alarms.clear(LICENSE_CHECK_ALARM);
  chrome.alarms.clear(LICENSE_STATUS_RETRY_ALARM);
  chrome.alarms.clear('ws-reconnect');
  chrome.alarms.clear(HEALTH_CHECK_ALARM_NAME);
  chrome.alarms.clear(CONNECTIVITY_HEALTH_ALARM_NAME);
  chrome.alarms.clear('heartbeat');
  // Also clear setInterval-based heartbeat
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
  if (eventHeartbeatTimer) clearTimeout(eventHeartbeatTimer);
  eventHeartbeatTimer = null;
  eventHeartbeatReason = null;
  settingsAlarmScheduled = false;
}

async function pauseNetworkForOffHours(reason, options = {}) {
  options.assertCurrent?.();
  if (offHoursNetworkPaused) {
    return;
  }
  console.log(`[Network] Pausing off-hours traffic (${reason})`);
  clearNetworkAlarms();
  scheduleHeartbeat(null);
  await disconnectWebSocket(options);
  options.assertCurrent?.();
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
  checkLicenseStatus('resume').catch(() => {});
  await updateTrackingState('resume');
}

async function safeSendHeartbeat(reason) {
  if (heartbeatInFlight) {
    console.log(`[Heartbeat] Skipping ${reason}; previous heartbeat still in flight`);
    return false;
  }
  if (Date.now() < apiBackoffUntilMs) {
    console.log(`[Heartbeat] Skipping ${reason}; API backoff active`);
    return false;
  }
  heartbeatInFlight = true;
  lastHeartbeatDispatchAt = Date.now();
  try {
    await sendHeartbeat(reason);
    return true;
  } catch (error) {
    if (globalThis.Sentry?.captureException) {
      globalThis.Sentry.captureException(error);
    }
    console.warn(`[Heartbeat] Failed (${reason}):`, safeDiagnosticError(error));
  } finally {
    heartbeatInFlight = false;
  }
}

function handleHeartbeatRecoveryAlarm(nowValue = Date.now()) {
  if (heartbeatInFlight) return Promise.resolve(false);
  if (
    lastHeartbeatDispatchAt > 0
    && nowValue - lastHeartbeatDispatchAt < HEARTBEAT_RECOVERY_STALE_MS
  ) {
    console.log('[Heartbeat] Recovery alarm skipped; 10-second cadence is healthy');
    return Promise.resolve(false);
  }
  return safeSendHeartbeat('alarm-recovery');
}

function scheduleEventHeartbeat(reason) {
  eventHeartbeatReason = reason;
  if (eventHeartbeatTimer) return;
  eventHeartbeatTimer = setTimeout(() => {
    const trailingReason = eventHeartbeatReason || 'event';
    eventHeartbeatReason = null;
    eventHeartbeatTimer = null;
    safeSendHeartbeat(`event:${trailingReason}`);
  }, EVENT_HEARTBEAT_COALESCE_MS);
}

function generateOpaqueTabRef() {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  return `tab_${String(random).replace(/[^a-zA-Z0-9]/g, '')}`;
}

function tabSnapshotAuthBinding(authContext = null) {
  return authContext
    ? monitoringEventAuthBindingForContext(authContext)
    : monitoringEventAuthBinding();
}

function buildOpaqueTabSnapshot(rawTabs, expectedAuthContext = null) {
  const tabs = (Array.isArray(rawTabs) ? rawTabs : [])
    .filter((tab) => Number.isInteger(tab?.id) && isHttpUrl(tab?.url))
    .slice(0, 20);
  let authContext = expectedAuthContext;
  if (!authContext) {
    try {
      authContext = captureAuthenticatedContext('tab snapshot');
    } catch {
      return Promise.resolve({ schemaVersion: 1, revision: 0, tabs: [], localEntries: [] });
    }
  }
  assertAuthenticatedContextCurrent(authContext, 'tab snapshot');
  const binding = tabSnapshotAuthBinding(authContext);
  if (!binding) {
    return Promise.resolve({ schemaVersion: 1, revision: 0, tabs: [], localEntries: [] });
  }

  tabSnapshotMutation = tabSnapshotMutation.catch(() => undefined).then(async () => {
    assertAuthenticatedContextCurrent(authContext, 'tab snapshot');
    const stored = await kv.get(TAB_SNAPSHOT_STORAGE_KEY);
    assertAuthenticatedContextCurrent(authContext, 'tab snapshot');
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
    if (bindingMatches && !changed && Number.isSafeInteger(priorRevision) && priorRevision >= 1) {
      currentTabSnapshotRevision = priorRevision;
      return {
        schemaVersion: 1,
        revision: priorRevision,
        tabs: localEntries.map(({ tabRef, url, title }) => ({ tabRef, url, title })),
        localEntries,
      };
    }
    const revision = Math.max(1, priorRevision + (changed ? 1 : 0));
    const next = {
      schemaVersion: 1,
      binding,
      revision,
      entries: localEntries,
      updatedAt: Date.now(),
    };
    assertAuthenticatedContextCurrent(authContext, 'tab snapshot persistence');
    await kv.set({ [TAB_SNAPSHOT_STORAGE_KEY]: next });
    assertAuthenticatedContextCurrent(authContext, 'tab snapshot persistence');
    currentTabSnapshotRevision = revision;
    return {
      schemaVersion: 1,
      revision,
      tabs: localEntries.map(({ tabRef, url, title }) => ({ tabRef, url, title })),
      localEntries,
    };
  });
  return tabSnapshotMutation;
}

async function resolveExactTabRefs(rawTabRefs, expectedRevision, expectedAuthContext = null) {
  const tabRefs = [...new Set((Array.isArray(rawTabRefs) ? rawTabRefs : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  if (tabRefs.length === 0) throw new Error('Missing exact tab references');
  const parsedExpected = Number(expectedRevision);
  if (!Number.isSafeInteger(parsedExpected) || parsedExpected < 1) {
    const error = new Error('Exact tab close requires a positive snapshot revision');
    error.code = 'TAB_SNAPSHOT_REVISION_REQUIRED';
    throw error;
  }
  const authContext = expectedAuthContext || captureAuthenticatedContext('exact tab resolution');
  assertAuthenticatedContextCurrent(authContext, 'exact tab resolution');
  const currentTabs = await chrome.tabs.query({});
  assertAuthenticatedContextCurrent(authContext, 'exact tab resolution');
  const snapshot = await buildOpaqueTabSnapshot(currentTabs, authContext);
  assertAuthenticatedContextCurrent(authContext, 'exact tab resolution');
  if (parsedExpected !== snapshot.revision) {
    const error = new Error('Tab snapshot is stale; refresh before closing tabs');
    error.code = 'STALE_TAB_SNAPSHOT';
    throw error;
  }
  const byRef = new Map(snapshot.localEntries.map((entry) => [entry.tabRef, entry]));
  const missing = tabRefs.filter((tabRef) => !byRef.has(tabRef));
  if (missing.length > 0) {
    const error = new Error('One or more exact tab references are no longer open');
    error.code = 'TAB_REF_NOT_FOUND';
    throw error;
  }
  return {
    revision: snapshot.revision,
    targets: tabRefs.map((tabRef) => {
      const entry = byRef.get(tabRef);
      return {
        tabRef,
        tabId: entry.tabId,
        expectedUrl: entry.url,
        expectedTitle: entry.title,
      };
    }),
  };
}

function normalizedLegacyTabUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

async function resolveUniqueLegacyTabUrls(rawUrls, expectedAuthContext = null) {
  const urls = [...new Set((Array.isArray(rawUrls) ? rawUrls : [])
    .map(normalizedLegacyTabUrl)
    .filter(Boolean))];
  if (urls.length === 0) {
    const error = new Error('Missing exact legacy tab URLs');
    error.code = 'TAB_TARGET_REQUIRED';
    throw error;
  }
  const authContext = expectedAuthContext || captureAuthenticatedContext('legacy tab resolution');
  assertAuthenticatedContextCurrent(authContext, 'legacy tab resolution');
  const tabs = (await chrome.tabs.query({})).filter((tab) => Number.isInteger(tab?.id));
  assertAuthenticatedContextCurrent(authContext, 'legacy tab resolution');
  const tabsByUrl = new Map();
  for (const tab of tabs) {
    const normalized = normalizedLegacyTabUrl(tab.url);
    if (!normalized) continue;
    const matches = tabsByUrl.get(normalized) || [];
    matches.push(tab);
    tabsByUrl.set(normalized, matches);
  }
  const targets = [];
  for (const url of urls) {
    const matches = tabsByUrl.get(url) || [];
    if (matches.length !== 1) {
      const error = new Error('Legacy URL target is missing or ambiguous; refresh for an exact tab reference');
      error.code = matches.length === 0 ? 'TAB_URL_NOT_FOUND' : 'AMBIGUOUS_TAB_URL';
      throw error;
    }
    targets.push(matches[0]);
  }
  const snapshot = await buildOpaqueTabSnapshot(tabs, authContext);
  assertAuthenticatedContextCurrent(authContext, 'legacy tab resolution');
  const entryById = new Map(snapshot.localEntries.map((entry) => [entry.tabId, entry]));
  return {
    revision: snapshot.revision,
    targets: targets.map((tab) => ({
      tabId: tab.id,
      tabRef: entryById.get(tab.id)?.tabRef || null,
      expectedUrl: String(tab.url || '').slice(0, 512),
      expectedTitle: String(tab.title || 'Untitled').slice(0, 512),
    })),
  };
}

async function revalidateExactTabTargets(exact, authContext, resolver = resolveExactTabRefs) {
  assertAuthenticatedContextCurrent(authContext, 'exact tab revalidation');
  const tabRefs = (exact?.targets || []).map((target) => target?.tabRef).filter(Boolean);
  const current = await resolver(tabRefs, exact?.revision, authContext);
  assertAuthenticatedContextCurrent(authContext, 'exact tab revalidation');
  const expectedIds = new Map((exact?.targets || []).map((target) => [target.tabRef, target.tabId]));
  if (current.targets.some((target) => expectedIds.get(target.tabRef) !== target.tabId)) {
    const error = new Error('Exact tab target changed after authorization');
    error.code = 'STALE_TAB_SNAPSHOT';
    throw error;
  }
  return current;
}

async function closeExactTabTargets(exact, authContext, options = {}) {
  const resolver = options.resolveExactTargets || resolveExactTabRefs;
  const getTab = options.getTab || ((tabId) => chrome.tabs.get(tabId));
  const verified = await revalidateExactTabTargets(exact, authContext, resolver);
  for (const target of verified.targets) {
    assertAuthenticatedContextCurrent(authContext, 'exact tab close');
    try {
      const tab = await getTab(target.tabId);
      assertAuthenticatedContextCurrent(authContext, 'exact tab close');
      if (
        !tab
        || tab.id !== target.tabId
        || String(tab.url || '').slice(0, 512) !== target.expectedUrl
        || String(tab.title || 'Untitled').slice(0, 512) !== target.expectedTitle
      ) {
        const error = new Error('Exact tab changed immediately before close');
        error.code = 'STALE_TAB_SNAPSHOT';
        throw error;
      }
      await chrome.tabs.remove(target.tabId);
      assertAuthenticatedContextCurrent(authContext, 'exact tab close');
    } catch (error) {
      if (error?.code === 'STALE_TAB_SNAPSHOT' || isAuthContextCancellation(error)) throw error;
      const closeError = new Error(`Exact tab ${target.tabRef || 'target'} could not be closed`);
      closeError.code = 'TAB_CLOSE_FAILED';
      throw closeError;
    }
  }
  assertAuthenticatedContextCurrent(authContext, 'exact tab close');
}

function setObservedState(isObserved, _reason) {
  if (observedByTeacher === isObserved) {
    return;
  }
  observedByTeacher = isObserved;
}

function transitionTrackingState(nextState, reason, options = {}) {
  const authContext = options.authContext || (() => {
    try {
      return captureAuthenticatedContext(`tracking transition:${reason}`);
    } catch {
      return null;
    }
  })();
  const mutationGeneration = options.authMutationGeneration ?? studentAuthMutationGeneration;
  if (options.authMutationHeld !== true) {
    return enqueueStudentAuthMutation(() => transitionTrackingStateNow(nextState, reason, {
      ...options,
      authContext,
      authMutationGeneration: mutationGeneration,
      authMutationHeld: true,
    }));
  }
  return transitionTrackingStateNow(nextState, reason, {
    ...options,
    authContext,
    authMutationGeneration: mutationGeneration,
  });
}

async function transitionTrackingStateNow(nextState, reason, options = {}) {
  const authContext = options.authContext || null;
  const expectedScope = authContext ? monitoringEventAuthBindingForContext(authContext) : null;
  const assertCurrent = (label = `tracking transition:${reason}`) => {
    if (authContext) assertAuthenticatedContextCurrent(authContext, label);
    else assertAuthMutationCurrent(options.authMutationGeneration, label);
  };
  assertCurrent();
  if (
    trackingState === nextState
    && persistedMonitoringState.state === nextState
    && persistedMonitoringStateScope === expectedScope
  ) return false;
  const changedAt = Date.now();
  trackingState = nextState;
  if (nextState === TRACKING_STATES.OFF) {
    advanceScreenshotPolicyAuthority();
    screenshotImmediateCapturePending = false;
  }
  persistedMonitoringState = { state: nextState, changedAt, reason };
  persistedMonitoringStateScope = expectedScope;
  await kv.set({
    [MONITORING_STATE_STORAGE_KEY]: persistedMonitoringState,
    ...(expectedScope ? { [MONITORING_STATE_SCOPE_KEY]: expectedScope } : {}),
  });
  try {
    assertCurrent();
  } catch (error) {
    if (expectedScope) {
      const stored = await kv.get([MONITORING_STATE_SCOPE_KEY]);
      if (stored[MONITORING_STATE_SCOPE_KEY] === expectedScope) {
        await kv.remove([MONITORING_STATE_STORAGE_KEY, MONITORING_STATE_SCOPE_KEY]);
        if (persistedMonitoringStateScope === expectedScope) {
          persistedMonitoringStateScope = null;
        }
      }
    }
    throw error;
  }
  const queued = await enqueueMonitoringEvent('monitoring_state_changed', {
    state: nextState.toLowerCase(),
    reason,
  }, { occurredAt: changedAt, authContext });
  assertCurrent();
  // Make a best-effort authenticated delivery while the socket/token/network
  // context is still intact. A retryable failure remains in the outbox.
  if (nextState === TRACKING_STATES.OFF && queued) {
    await flushMonitoringEventOutbox();
    assertCurrent();
  }
  if (nextState === TRACKING_STATES.OFF) {
    await chrome.alarms.clear(CONNECTIVITY_HEALTH_ALARM_NAME);
    assertCurrent();
  } else {
    await scheduleConnectivityHealthBoundary();
    assertCurrent();
  }
  await setConnectivityBadge(connectivityStatus());
  assertCurrent();
  console.log(`[Tracking] State updated to ${trackingState} (${reason})`);
  return true;
}

async function updateTrackingState(reason = 'state-check') {
  const decisionMutationGeneration = studentAuthMutationGeneration;
  let decisionAuthContext = null;
  try {
    if (hasStudentAuth()) {
      decisionAuthContext = captureAuthenticatedContext(`tracking decision:${reason}`);
    }
  } catch {
    return;
  }
  const assertDecisionCurrent = () => {
    if (decisionAuthContext) {
      assertAuthenticatedContextCurrent(decisionAuthContext, `tracking decision:${reason}`);
    } else {
      assertAuthMutationCurrent(decisionMutationGeneration, `tracking decision:${reason}`);
    }
  };
  const disconnectOptions = decisionAuthContext
    ? { authContext: decisionAuthContext, assertCurrent: assertDecisionCurrent }
    : {
        authMutationGeneration: decisionMutationGeneration,
        assertCurrent: assertDecisionCurrent,
      };
  assertDecisionCurrent();
  if (!currentLicenseIsActive()) {
    if (trackingState !== TRACKING_STATES.OFF) {
      await transitionTrackingState(TRACKING_STATES.OFF, 'license_inactive', {
        authContext: decisionAuthContext,
        authMutationGeneration: decisionMutationGeneration,
      });
      assertDecisionCurrent();
      scheduleHeartbeat(null);
      scheduleScreenshotCapture(false);  // Disable screenshots when license inactive
      await disconnectWebSocket(disconnectOptions);
    }
    return;
  }

  if (await expireManualAuthIfStale(`tracking:${reason}`)) {
    return;
  }
  assertDecisionCurrent();

  if (!hasStudentAuth()) {
    scheduleHealthCheckAlarm(5);
    if (trackingState !== TRACKING_STATES.OFF) {
      await transitionTrackingState(TRACKING_STATES.OFF, 'auth_required', {
        authMutationGeneration: decisionMutationGeneration,
      });
      assertDecisionCurrent();
      scheduleHeartbeat(null);
      scheduleScreenshotCapture(false);
      await disconnectWebSocket(disconnectOptions);
    }
    assertDecisionCurrent();
    await notifyAuthGateStateToTabs();
    return;
  }

  const nextState = determineTrackingState();
  if (nextState === TRACKING_STATES.OFF && isScheduleHardOff) {
    if (trackingState !== nextState) {
      await transitionTrackingState(nextState, reason, {
        authContext: decisionAuthContext,
        authMutationGeneration: decisionMutationGeneration,
      });
      assertDecisionCurrent();
    }
    await pauseNetworkForOffHours(reason, disconnectOptions);
    return;
  }

  if (offHoursNetworkPaused) {
    await resumeNetworkAfterOffHours(reason);
    return;
  }

  if (trackingState === nextState) {
    return;
  }

  await transitionTrackingState(nextState, reason, {
    authContext: decisionAuthContext,
    authMutationGeneration: decisionMutationGeneration,
  });
  assertDecisionCurrent();

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
    await disconnectWebSocket(disconnectOptions);
  }
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
  // Keep the worker alive through the first state transition. A detached
  // promise can be suspended before it creates the heartbeat/screenshot
  // alarms, even when an exact-scope active entitlement was restored.
  await updateTrackingState(reason);
  assertCurrent();
}

const MONITORING_EVENT_OUTBOX_KEY = 'monitoringEventOutboxV1';
const MONITORING_EVENT_DROPPED_KEY = 'monitoringEventOutboxDropped';
const MONITORING_EVENT_AUTH_BINDING_KEY = 'monitoringEventOutboxAuthBindingV1';
const MONITORING_EVENT_FLUSH_ALARM = 'monitoring-event-flush';
const MONITORING_EVENT_FLUSH_MS = 5000;
let monitoringEventFlushTimer = null;
let monitoringEventFlushInFlight = null;
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
let commandAckFlushInFlight = null;
let commandAckRetryDelayMs = COMMAND_ACK_HTTP_FALLBACK_MS;
const CHAT_ACK_OUTBOX_KEY = 'chatAckOutboxV1';
const CHAT_ACK_BINDING_KEY = 'chatAckOutboxAuthBindingV1';
const CHAT_ACK_FLUSH_ALARM = 'chat-ack-flush';
let chatAckMutation = Promise.resolve();
let chatAckFlushInFlight = null;
const STUDENT_CHAT_OUTBOX_KEY = 'studentChatOutboxV1';
const STUDENT_CHAT_OUTBOX_BINDING_KEY = 'studentChatOutboxAuthBindingV1';
const STUDENT_CHAT_FLUSH_ALARM = 'student-chat-flush';
const STUDENT_CHAT_MAX_ENTRIES = 40;
const STUDENT_CHAT_MAX_BYTES = 128 * 1024;
const STUDENT_CHAT_MAX_AGE_MS = 30 * 60 * 1000;
const STUDENT_CHAT_RETRY_DELAYS_MS = Object.freeze([5000, 15000, 30000, 60000, 120000]);
let studentChatMutation = Promise.resolve();
let studentChatFlushInFlight = null;

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
  const normalizedErrorCode = rawAck?.error
    ? commandDiagnosticCode({ code: rawAck?.errorCode })
    : undefined;
  return {
    type: 'command-ack',
    ackId,
    commandId,
    ackState,
    commandType: safeDiagnosticLabel(rawAck?.commandType),
    bindingVersion: Number(rawAck?.bindingVersion || 0) || undefined,
    authContextId: String(rawAck?.authContextId || '').slice(0, 128) || undefined,
    schoolId: String(rawAck?.schoolId || '').slice(0, 256) || undefined,
    studentId: String(rawAck?.studentId || '').slice(0, 256) || undefined,
    studentSessionId: String(rawAck?.studentSessionId || '').slice(0, 256) || undefined,
    deviceId: String(rawAck?.deviceId || '').slice(0, 256) || undefined,
    studentControlRevision: Number.isSafeInteger(Number(rawAck?.studentControlRevision))
      && Number(rawAck.studentControlRevision) >= 0
      ? Number(rawAck.studentControlRevision)
      : undefined,
    result: boundedAckObject(rawAck?.result),
    state: boundedAckObject(rawAck?.state),
    error: normalizedErrorCode ? COMMAND_DIAGNOSTIC_MESSAGES[normalizedErrorCode] : undefined,
    errorCode: normalizedErrorCode,
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

function scheduleCommandAckExpiry(entries, nowValue = Date.now()) {
  const expiries = (Array.isArray(entries) ? entries : [])
    .map((ack) => Number(ack?.queuedAt || 0) + COMMAND_ACK_MAX_AGE_MS + 1)
    .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > nowValue);
  if (expiries.length === 0) return;
  scheduleCommandAckFlush(Math.max(1000, Math.min(...expiries) - nowValue));
}

const TERMINAL_COMMAND_ACK_RECEIPT_CODES = new Set([
  'COMMAND_ACK_MALFORMED',
  'COMMAND_ACK_BINDING_MISMATCH',
  'COMMAND_ACK_TARGET_GONE',
  'COMMAND_ACK_TARGET_EXPIRED',
  'COMMAND_ACK_INVALID_TRANSITION',
]);

function commandAckReceiptIsDrainable(receipt, requireDisposition = false) {
  const disposition = String(receipt?.disposition || '').trim();
  if (!disposition) return !requireDisposition && receipt?.accepted === true;
  if (receipt?.retryable === true) return false;
  if (disposition === 'applied' || disposition === 'idempotent') {
    return receipt?.accepted === true;
  }
  if (disposition !== 'terminal_rejected' || receipt?.retryable !== false) return false;
  return TERMINAL_COMMAND_ACK_RECEIPT_CODES.has(String(receipt?.code || '').trim());
}

function acceptedAckReceiptIds(receipts, entries, authContext, kind = 'command') {
  const storedByAckId = new Map((Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.ackId)
    .map((entry) => [String(entry.ackId), entry]));
  const requireExact = kind === 'command'
    && hasNegotiatedCapability('exactBindingAckV2', authContext);
  const accepted = [];
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (kind === 'command') {
      if (!commandAckReceiptIsDrainable(receipt, requireExact)) continue;
    } else if (receipt?.accepted !== true) {
      continue;
    }
    const ackId = String(receipt.ackId || '').trim();
    const stored = storedByAckId.get(ackId);
    if (!stored) continue;
    const storedTargetId = String(kind === 'chat' ? stored.messageId || '' : stored.commandId || '');
    const receiptTargetId = String(kind === 'chat'
      ? receipt.messageId || receipt.chatMessageId || ''
      : receipt.commandId || '');
    if (kind === 'command' && (!receiptTargetId || receiptTargetId !== storedTargetId)) continue;
    if (kind !== 'command' && receiptTargetId && receiptTargetId !== storedTargetId) continue;
    if (requireExact) {
      const storedControlRevision = Number(stored.studentControlRevision);
      if (
        Number(stored.bindingVersion) !== 2
        || stored.schoolId !== authContext.schoolId
        || stored.deviceId !== authContext.deviceId
        || stored.studentId !== authContext.studentId
        || stored.studentSessionId !== authContext.studentSessionId
        || !Number.isSafeInteger(storedControlRevision)
      ) continue;
    }
    accepted.push(ackId);
  }
  return [...new Set(accepted)];
}

async function removeAcceptedCommandAckReceipts(receipts, authContext) {
  await commandAckMutation;
  assertAuthenticatedContextCurrent(authContext, 'command acknowledgement receipt');
  const stored = await durableLocalKv.get([COMMAND_ACK_OUTBOX_KEY, COMMAND_ACK_BINDING_KEY]);
  assertAuthenticatedContextCurrent(authContext, 'command acknowledgement receipt');
  if (stored[COMMAND_ACK_BINDING_KEY] !== monitoringEventAuthBindingForContext(authContext)) return 0;
  const entries = boundCommandAckOutbox(stored[COMMAND_ACK_OUTBOX_KEY]);
  const receiptIds = acceptedAckReceiptIds(receipts, entries, authContext, 'command');
  if (receiptIds.length === 0) return 0;
  const remaining = await removeCommandAcks(receiptIds, authContext);
  return Math.max(0, entries.length - remaining);
}

function scheduleCommandAckFlush(delayMs = COMMAND_ACK_HTTP_FALLBACK_MS) {
  chrome.alarms.get(COMMAND_ACK_FLUSH_ALARM, (existing) => {
    const when = Date.now() + Math.max(1000, Number(delayMs || 0));
    if (
      !existing
      || Number(existing.scheduledTime || 0) <= Date.now()
      || existing.scheduledTime > when
    ) {
      chrome.alarms.create(COMMAND_ACK_FLUSH_ALARM, { when });
    }
  });
}

function enqueueCommandAck(rawAck, authContext) {
  assertAuthenticatedContextCurrent(authContext, 'command acknowledgement persistence');
  const binding = monitoringEventAuthBindingForContext(authContext);
  const normalized = normalizeCommandAckForStorage(rawAck);
  if (!binding || !normalized) return Promise.resolve(false);

  commandAckMutation = commandAckMutation.catch(() => undefined).then(async () => {
    assertAuthenticatedContextCurrent(authContext, 'command acknowledgement persistence');
    const stored = await durableLocalKv.get([COMMAND_ACK_OUTBOX_KEY, COMMAND_ACK_BINDING_KEY]);
    assertAuthenticatedContextCurrent(authContext, 'command acknowledgement persistence');
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
    assertAuthenticatedContextCurrent(authContext, 'command acknowledgement persistence');
    await durableLocalKv.set({
      [COMMAND_ACK_OUTBOX_KEY]: entries,
      [COMMAND_ACK_BINDING_KEY]: binding,
    });
    assertAuthenticatedContextCurrent(authContext, 'command acknowledgement persistence');
    scheduleCommandAckExpiry(entries);
    return true;
  });
  return commandAckMutation;
}

function removeCommandAcks(ackIds, expectedAuthContext = null) {
  const acknowledged = new Set((Array.isArray(ackIds) ? ackIds : []).filter(Boolean));
  commandAckMutation = commandAckMutation.catch(() => undefined).then(async () => {
    if (expectedAuthContext) {
      assertAuthenticatedContextCurrent(expectedAuthContext, 'command acknowledgement removal');
    }
    const stored = await durableLocalKv.get([COMMAND_ACK_OUTBOX_KEY, COMMAND_ACK_BINDING_KEY]);
    if (expectedAuthContext) {
      assertAuthenticatedContextCurrent(expectedAuthContext, 'command acknowledgement removal');
      if (
        stored[COMMAND_ACK_BINDING_KEY]
        !== monitoringEventAuthBindingForContext(expectedAuthContext)
      ) return boundCommandAckOutbox(stored[COMMAND_ACK_OUTBOX_KEY]).length;
    }
    const remaining = boundCommandAckOutbox(stored[COMMAND_ACK_OUTBOX_KEY])
      .filter((ack) => !acknowledged.has(ack.ackId));
    await durableLocalKv.set({ [COMMAND_ACK_OUTBOX_KEY]: remaining });
    if (remaining.length === 0) {
      commandAckRetryDelayMs = COMMAND_ACK_HTTP_FALLBACK_MS;
      await durableLocalKv.remove(COMMAND_ACK_BINDING_KEY);
      await chrome.alarms.clear(COMMAND_ACK_FLUSH_ALARM);
    } else {
      scheduleCommandAckExpiry(remaining);
    }
    return remaining.length;
  });
  return commandAckMutation;
}

async function discardCommandAckOutbox() {
  commandAckMutation = commandAckMutation.catch(() => undefined).then(async () => {
    await durableLocalKv.set({ [COMMAND_ACK_OUTBOX_KEY]: [] });
    await durableLocalKv.remove(COMMAND_ACK_BINDING_KEY);
    await chrome.alarms.clear(COMMAND_ACK_FLUSH_ALARM);
  });
  return commandAckMutation;
}

function compactCommandAckStorageOnly(nowValue = Date.now()) {
  commandAckMutation = commandAckMutation.catch(() => undefined).then(async () => {
    const stored = await durableLocalKv.get([COMMAND_ACK_OUTBOX_KEY, COMMAND_ACK_BINDING_KEY]);
    const compacted = boundCommandAckOutbox(stored[COMMAND_ACK_OUTBOX_KEY], nowValue);
    await durableLocalKv.set({ [COMMAND_ACK_OUTBOX_KEY]: compacted });
    if (compacted.length === 0) {
      await durableLocalKv.remove(COMMAND_ACK_BINDING_KEY);
      await chrome.alarms.clear(COMMAND_ACK_FLUSH_ALARM);
    } else {
      scheduleCommandAckExpiry(compacted, nowValue);
    }
    return compacted;
  });
  return commandAckMutation;
}

function compactCommandAckOutbox(authContext) {
  const binding = monitoringEventAuthBindingForContext(authContext);
  commandAckMutation = commandAckMutation.catch(() => undefined).then(async () => {
    assertAuthenticatedContextCurrent(authContext, 'command acknowledgement compaction');
    const stored = await durableLocalKv.get([COMMAND_ACK_OUTBOX_KEY, COMMAND_ACK_BINDING_KEY]);
    assertAuthenticatedContextCurrent(authContext, 'command acknowledgement compaction');
    if (!binding || stored[COMMAND_ACK_BINDING_KEY] !== binding) return null;
    const compacted = boundCommandAckOutbox(stored[COMMAND_ACK_OUTBOX_KEY]);
    await durableLocalKv.set({ [COMMAND_ACK_OUTBOX_KEY]: compacted });
    assertAuthenticatedContextCurrent(authContext, 'command acknowledgement compaction');
    if (compacted.length === 0) {
      commandAckRetryDelayMs = COMMAND_ACK_HTTP_FALLBACK_MS;
      await durableLocalKv.remove(COMMAND_ACK_BINDING_KEY);
      await chrome.alarms.clear(COMMAND_ACK_FLUSH_ALARM);
    } else {
      scheduleCommandAckExpiry(compacted);
    }
    assertAuthenticatedContextCurrent(authContext, 'command acknowledgement compaction');
    return compacted;
  });
  return commandAckMutation;
}

async function flushCommandAckOutbox(options = {}) {
  if (!hasStudentAuth()) return;
  let authContext;
  try {
    authContext = captureAuthenticatedContext('command acknowledgement flush');
  } catch (error) {
    if (isAuthContextCancellation(error)) return;
    throw error;
  }
  const binding = monitoringEventAuthBindingForContext(authContext);
  if (!binding) return;
  const activeFlush = commandAckFlushInFlight;
  if (activeFlush) {
    if (activeFlush.binding === binding) return activeFlush.promise;
    scheduleCommandAckFlush(1000);
    return activeFlush.promise.catch(() => undefined).then(() => {
      assertAuthenticatedContextCurrent(authContext, 'command acknowledgement flush handoff');
      return flushCommandAckOutbox(options);
    }).catch((error) => {
      if (!isAuthContextCancellation(error)) scheduleCommandAckFlush(1000);
    });
  }
  const owner = { binding, promise: null };
  const run = (async () => {
    try {
      const compacted = await compactCommandAckOutbox(authContext);
      assertAuthenticatedContextCurrent(authContext, 'command acknowledgement flush');
      if (!compacted) return;
      const batch = compacted.slice(0, 50);
      if (batch.length === 0) return;

      let wsAttempted = false;
      if (wsConnected) {
        for (const ack of batch) {
          wsAttempted = (await wsSend(ack, authContext)) || wsAttempted;
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
      assertAuthenticatedContextCurrent(authContext, 'command acknowledgement flush');
      const response = await fetchWithBackoff(`${authContext.serverOrigin}/api/classpilot/device/command-acks`, {
        method: 'POST',
        headers: buildDeviceAuthHeaders(authContext),
        body: JSON.stringify(payload),
        signal: authContext.signal,
      }, {
        context: 'command acknowledgement',
        maxAttempts: 1,
        retryStatuses: new Set([429, 503]),
      });
      assertAuthenticatedContextCurrent(authContext, 'command acknowledgement flush');
      if (!response.ok) {
        commandAckRetryDelayMs = Math.min(commandAckRetryDelayMs * 2, 5 * 60 * 1000);
        scheduleCommandAckFlush(commandAckRetryDelayMs);
        return;
      }
      const data = await response.json().catch(() => ({}));
      assertAuthenticatedContextCurrent(authContext, 'command acknowledgement receipt');
      const receiptIds = acceptedAckReceiptIds(data.receipts, batch, authContext, 'command');
      if (receiptIds.length === 0) {
        commandAckRetryDelayMs = Math.min(commandAckRetryDelayMs * 2, 5 * 60 * 1000);
        scheduleCommandAckFlush(commandAckRetryDelayMs);
        return;
      }
      assertAuthenticatedContextCurrent(authContext, 'command acknowledgement receipt');
      const remaining = await removeCommandAcks(receiptIds, authContext);
      commandAckRetryDelayMs = COMMAND_ACK_HTTP_FALLBACK_MS;
      if (remaining > 0) scheduleCommandAckFlush();
    } catch (error) {
      if (!isAuthContextCancellation(error)) {
        console.warn('[Command ACK] Flush deferred:', safeDiagnosticError(error));
        commandAckRetryDelayMs = Math.min(commandAckRetryDelayMs * 2, 5 * 60 * 1000);
        scheduleCommandAckFlush(commandAckRetryDelayMs);
      }
    }
  })();
  owner.promise = run.finally(() => {
    if (commandAckFlushInFlight === owner) commandAckFlushInFlight = null;
  });
  commandAckFlushInFlight = owner;
  return owner.promise;
}

function scheduleChatAckFlush(delayMs = COMMAND_ACK_HTTP_FALLBACK_MS) {
  chrome.alarms.get(CHAT_ACK_FLUSH_ALARM, (existing) => {
    const when = Date.now() + Math.max(1000, Number(delayMs || 0));
    if (
      !existing
      || Number(existing.scheduledTime || 0) <= Date.now()
      || existing.scheduledTime > when
    ) {
      chrome.alarms.create(CHAT_ACK_FLUSH_ALARM, { when });
    }
  });
}

function enqueueChatAck(rawAck, authContext) {
  assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement persistence');
  const binding = monitoringEventAuthBindingForContext(authContext);
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
    bindingVersion: 2,
    schoolId: authContext.schoolId || undefined,
    deviceId: authContext.deviceId,
    studentId: authContext.studentId,
    studentSessionId: authContext.studentSessionId,
    studentControlRevision: currentStudentControlRevision() ?? undefined,
    timestamp: rawAck.timestamp || new Date().toISOString(),
    queuedAt: Date.now(),
  };
  chatAckMutation = chatAckMutation.catch(() => undefined).then(async () => {
    assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement persistence');
    const stored = await durableLocalKv.get([CHAT_ACK_OUTBOX_KEY, CHAT_ACK_BINDING_KEY]);
    assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement persistence');
    let entries = stored[CHAT_ACK_BINDING_KEY] === binding
      ? boundChatAckOutbox(stored[CHAT_ACK_OUTBOX_KEY])
      : [];
    entries = entries.filter((item) => item.ackId !== ack.ackId);
    if (ack.status === 'delivered') {
      entries = entries.filter((item) => item.messageId !== ack.messageId);
    }
    entries.push(ack);
    entries = boundChatAckOutbox(entries);
    assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement persistence');
    await durableLocalKv.set({ [CHAT_ACK_OUTBOX_KEY]: entries, [CHAT_ACK_BINDING_KEY]: binding });
    assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement persistence');
    scheduleChatAckExpiry(entries);
    return true;
  });
  return chatAckMutation;
}

async function removeAcceptedChatAckReceipts(receipts, authContext) {
  await chatAckMutation;
  assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement receipt');
  const stored = await durableLocalKv.get([CHAT_ACK_OUTBOX_KEY, CHAT_ACK_BINDING_KEY]);
  assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement receipt');
  if (stored[CHAT_ACK_BINDING_KEY] !== monitoringEventAuthBindingForContext(authContext)) return 0;
  const entries = boundChatAckOutbox(stored[CHAT_ACK_OUTBOX_KEY]);
  const receiptIds = acceptedAckReceiptIds(receipts, entries, authContext, 'chat');
  if (receiptIds.length === 0) return 0;
  const remaining = await removeChatAcks(receiptIds, authContext);
  return Math.max(0, entries.length - remaining);
}

function removeChatAcks(ackIds, expectedAuthContext = null) {
  const acknowledged = new Set(ackIds || []);
  chatAckMutation = chatAckMutation.catch(() => undefined).then(async () => {
    if (expectedAuthContext) {
      assertAuthenticatedContextCurrent(expectedAuthContext, 'chat acknowledgement removal');
    }
    const stored = await durableLocalKv.get([CHAT_ACK_OUTBOX_KEY, CHAT_ACK_BINDING_KEY]);
    if (expectedAuthContext) {
      assertAuthenticatedContextCurrent(expectedAuthContext, 'chat acknowledgement removal');
      if (
        stored[CHAT_ACK_BINDING_KEY]
        !== monitoringEventAuthBindingForContext(expectedAuthContext)
      ) return (stored[CHAT_ACK_OUTBOX_KEY] || []).length;
    }
    const remaining = boundChatAckOutbox(stored[CHAT_ACK_OUTBOX_KEY])
      .filter((ack) => !acknowledged.has(ack.ackId));
    await durableLocalKv.set({ [CHAT_ACK_OUTBOX_KEY]: remaining });
    if (remaining.length === 0) {
      await durableLocalKv.remove(CHAT_ACK_BINDING_KEY);
      await chrome.alarms.clear(CHAT_ACK_FLUSH_ALARM);
    } else {
      scheduleChatAckExpiry(remaining);
    }
    return remaining.length;
  });
  return chatAckMutation;
}

async function discardChatAckOutbox() {
  chatAckMutation = chatAckMutation.catch(() => undefined).then(async () => {
    await durableLocalKv.set({ [CHAT_ACK_OUTBOX_KEY]: [] });
    await durableLocalKv.remove(CHAT_ACK_BINDING_KEY);
    await chrome.alarms.clear(CHAT_ACK_FLUSH_ALARM);
  });
  return chatAckMutation;
}

function compactChatAckStorageOnly(nowValue = Date.now()) {
  chatAckMutation = chatAckMutation.catch(() => undefined).then(async () => {
    const stored = await durableLocalKv.get([CHAT_ACK_OUTBOX_KEY, CHAT_ACK_BINDING_KEY]);
    const compacted = boundChatAckOutbox(stored[CHAT_ACK_OUTBOX_KEY], nowValue);
    await durableLocalKv.set({ [CHAT_ACK_OUTBOX_KEY]: compacted });
    if (compacted.length === 0) {
      await durableLocalKv.remove(CHAT_ACK_BINDING_KEY);
      await chrome.alarms.clear(CHAT_ACK_FLUSH_ALARM);
    } else {
      scheduleChatAckExpiry(compacted, nowValue);
    }
    return compacted;
  });
  return chatAckMutation;
}

function compactChatAckOutbox(authContext) {
  const binding = monitoringEventAuthBindingForContext(authContext);
  chatAckMutation = chatAckMutation.catch(() => undefined).then(async () => {
    assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement compaction');
    const stored = await durableLocalKv.get([CHAT_ACK_OUTBOX_KEY, CHAT_ACK_BINDING_KEY]);
    assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement compaction');
    if (!binding || stored[CHAT_ACK_BINDING_KEY] !== binding) return null;
    const compacted = boundChatAckOutbox(stored[CHAT_ACK_OUTBOX_KEY]);
    await durableLocalKv.set({ [CHAT_ACK_OUTBOX_KEY]: compacted });
    assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement compaction');
    if (compacted.length === 0) {
      await durableLocalKv.remove(CHAT_ACK_BINDING_KEY);
      await chrome.alarms.clear(CHAT_ACK_FLUSH_ALARM);
    } else {
      scheduleChatAckExpiry(compacted);
    }
    assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement compaction');
    return compacted;
  });
  return chatAckMutation;
}

async function flushChatAckOutbox(options = {}) {
  if (!hasStudentAuth()) return;
  let authContext;
  try {
    authContext = captureAuthenticatedContext('chat acknowledgement flush');
  } catch (error) {
    if (isAuthContextCancellation(error)) return;
    throw error;
  }
  const binding = monitoringEventAuthBindingForContext(authContext);
  if (!binding) return;
  const activeFlush = chatAckFlushInFlight;
  if (activeFlush) {
    if (activeFlush.binding === binding) return activeFlush.promise;
    scheduleChatAckFlush(1000);
    return activeFlush.promise.catch(() => undefined).then(() => {
      assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement flush handoff');
      return flushChatAckOutbox(options);
    }).catch((error) => {
      if (!isAuthContextCancellation(error)) scheduleChatAckFlush(1000);
    });
  }
  const owner = { binding, promise: null };
  const run = (async () => {
    try {
      const compacted = await compactChatAckOutbox(authContext);
      assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement flush');
      if (!compacted) return;
      const batch = compacted.slice(0, 50);
      if (batch.length === 0) {
        await chrome.alarms.clear(CHAT_ACK_FLUSH_ALARM);
        return;
      }
      let wsAttempted = false;
      if (wsConnected) {
        for (const ack of batch) wsAttempted = (await wsSend(ack, authContext)) || wsAttempted;
      }
      const oldestAge = Date.now() - Math.min(...batch.map((ack) => Number(ack.queuedAt || 0)));
      if (wsAttempted && oldestAge < COMMAND_ACK_HTTP_FALLBACK_MS && options.forceHttp !== true) {
        scheduleChatAckFlush(COMMAND_ACK_HTTP_FALLBACK_MS - oldestAge);
        return;
      }
      assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement flush');
      const response = await fetchWithBackoff(`${authContext.serverOrigin}/api/classpilot/device/chat-acks`, {
        method: 'POST',
        headers: buildDeviceAuthHeaders(authContext),
        body: JSON.stringify({
          acks: batch.map(({ queuedAt, type, chatMessageId, deliveryStatus, timestamp, sessionId, ...ack }) => ack),
        }),
        signal: authContext.signal,
      }, {
        context: 'chat acknowledgement',
        maxAttempts: 1,
        retryStatuses: new Set([429, 503]),
      });
      assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement flush');
      if (!response.ok) {
        scheduleChatAckFlush(30 * 1000);
        return;
      }
      const data = await response.json().catch(() => ({}));
      assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement receipt');
      const receiptIds = acceptedAckReceiptIds(data.receipts, batch, authContext, 'chat');
      if (binding !== monitoringEventAuthBindingForContext(authContext)) return;
      if (receiptIds.length === 0) {
        scheduleChatAckFlush(30 * 1000);
        return;
      }
      const remaining = await removeChatAcks(receiptIds, authContext);
      if (remaining > 0) scheduleChatAckFlush();
    } catch (error) {
      if (!isAuthContextCancellation(error)) {
        console.warn('[Chat ACK] Flush deferred:', safeDiagnosticError(error));
        scheduleChatAckFlush(30 * 1000);
      }
    }
  })();
  owner.promise = run.finally(() => {
    if (chatAckFlushInFlight === owner) chatAckFlushInFlight = null;
  });
  chatAckFlushInFlight = owner;
  return owner.promise;
}

function generateStudentChatClientMessageId() {
  return globalThis.crypto?.randomUUID?.()
    || `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeStudentChatEntry(raw = {}) {
  const clientMessageId = String(raw.clientMessageId || '').trim().slice(0, 128);
  const message = String(raw.message || '').trim().slice(0, 500);
  const sessionId = String(raw.sessionId || '').trim().slice(0, 256);
  const binding = String(raw.binding || '').trim();
  if (!clientMessageId || !message || !sessionId || !binding) return null;
  const status = ['sending', 'retrying', 'failed'].includes(raw.status)
    ? raw.status
    : 'sending';
  return {
    schemaVersion: 1,
    clientMessageId,
    message,
    messageType: raw.messageType === 'question' ? 'question' : 'message',
    sessionId,
    binding,
    queuedAt: Number(raw.queuedAt || Date.now()),
    updatedAt: Number(raw.updatedAt || Date.now()),
    lastAttemptAt: Number(raw.lastAttemptAt || 0),
    attempts: Math.max(0, Number(raw.attempts || 0)),
    status,
    errorCode: raw.errorCode ? String(raw.errorCode).slice(0, 80) : null,
  };
}

function boundedStudentChatOutbox(rawEntries, nowValue = Date.now()) {
  const entries = (Array.isArray(rawEntries) ? rawEntries : [])
    .map(normalizeStudentChatEntry)
    .filter(Boolean)
    .filter((entry) => entry.queuedAt >= nowValue - STUDENT_CHAT_MAX_AGE_MS)
    .slice(-STUDENT_CHAT_MAX_ENTRIES);
  while (entries.length > 0 && RuntimeCore.utf8ByteLength(entries) > STUDENT_CHAT_MAX_BYTES) {
    entries.shift();
  }
  return entries;
}

async function notifyStudentChatStatus(entry, status, details = {}, authContext = null) {
  if (authContext) assertAuthenticatedContextCurrent(authContext, 'student message status');
  const update = {
    clientMessageId: entry.clientMessageId,
    messageId: details.messageId || null,
    status,
    duplicate: details.duplicate === true,
    errorCode: details.errorCode || null,
    updatedAt: Date.now(),
  };
  // Status updates contain no message body or identity. Content scripts can
  // update the exact optimistic bubble without exposing another student's
  // durable outbox after an authentication transition.
  if (authContext) {
    await broadcastToAllTabsForAuth(
      'student-message-status',
      update,
      authContext,
      browserPolicyEnvelopeForAuth(authContext),
    ).catch((error) => {
      if (isAuthContextCancellation(error)) throw error;
    });
    assertAuthenticatedContextCurrent(authContext, 'student message status');
  } else {
    await broadcastToAllTabs('student-message-status', update).catch(() => {});
  }
  return update;
}

function scheduleStudentChatFlush(delayMs = STUDENT_CHAT_RETRY_DELAYS_MS[0]) {
  const when = Date.now() + Math.max(1000, Number(delayMs || 0));
  chrome.alarms.get(STUDENT_CHAT_FLUSH_ALARM, (existing) => {
    if (
      !existing
      || Number(existing.scheduledTime || 0) <= Date.now()
      || existing.scheduledTime > when
    ) {
      chrome.alarms.create(STUDENT_CHAT_FLUSH_ALARM, { when });
    }
  });
}

function mutateStudentChatOutbox(operation) {
  studentChatMutation = studentChatMutation.then(operation, operation);
  return studentChatMutation;
}

function persistStudentChatEntry(rawEntry, authContext) {
  const binding = monitoringEventAuthBindingForContext(authContext);
  if (!binding) throw authContextSuperseded('student message persistence');
  const entry = normalizeStudentChatEntry({ ...rawEntry, binding });
  if (!entry) throw new Error('Student message is incomplete');
  return mutateStudentChatOutbox(async () => {
    assertAuthenticatedContextCurrent(authContext, 'student message persistence');
    const stored = await durableLocalKv.get([
      STUDENT_CHAT_OUTBOX_KEY,
      STUDENT_CHAT_OUTBOX_BINDING_KEY,
    ]);
    assertAuthenticatedContextCurrent(authContext, 'student message persistence');
    const entries = stored[STUDENT_CHAT_OUTBOX_BINDING_KEY] === binding
      ? boundedStudentChatOutbox(stored[STUDENT_CHAT_OUTBOX_KEY])
      : [];
    const withoutSameId = entries.filter((item) => item.clientMessageId !== entry.clientMessageId);
    const next = boundedStudentChatOutbox([...withoutSameId, entry]);
    if (!next.some((item) => item.clientMessageId === entry.clientMessageId)) {
      const error = new Error('Student message outbox is full');
      error.code = 'STUDENT_CHAT_OUTBOX_FULL';
      throw error;
    }
    assertAuthenticatedContextCurrent(authContext, 'student message persistence');
    await durableLocalKv.set({
      [STUDENT_CHAT_OUTBOX_KEY]: next,
      [STUDENT_CHAT_OUTBOX_BINDING_KEY]: binding,
    });
    assertAuthenticatedContextCurrent(authContext, 'student message persistence');
    scheduleStudentChatExpiry(next);
    return entry;
  });
}

function updateStudentChatEntry(clientMessageId, updates, authContext) {
  const binding = monitoringEventAuthBindingForContext(authContext);
  return mutateStudentChatOutbox(async () => {
    assertAuthenticatedContextCurrent(authContext, 'student message update');
    const stored = await durableLocalKv.get([
      STUDENT_CHAT_OUTBOX_KEY,
      STUDENT_CHAT_OUTBOX_BINDING_KEY,
    ]);
    assertAuthenticatedContextCurrent(authContext, 'student message update');
    if (stored[STUDENT_CHAT_OUTBOX_BINDING_KEY] !== binding) {
      throw authContextSuperseded('student message update');
    }
    let updated = null;
    const next = boundedStudentChatOutbox(stored[STUDENT_CHAT_OUTBOX_KEY]).map((entry) => {
      if (entry.clientMessageId !== clientMessageId) return entry;
      updated = normalizeStudentChatEntry({ ...entry, ...updates, binding, updatedAt: Date.now() });
      return updated;
    });
    if (!updated) throw new Error('Student message outbox entry is unavailable');
    await durableLocalKv.set({ [STUDENT_CHAT_OUTBOX_KEY]: next });
    assertAuthenticatedContextCurrent(authContext, 'student message update');
    scheduleStudentChatExpiry(next);
    return updated;
  });
}

function removeDeliveredStudentChatEntry(clientMessageId, authContext) {
  const binding = monitoringEventAuthBindingForContext(authContext);
  return mutateStudentChatOutbox(async () => {
    assertAuthenticatedContextCurrent(authContext, 'student message receipt');
    const stored = await durableLocalKv.get([
      STUDENT_CHAT_OUTBOX_KEY,
      STUDENT_CHAT_OUTBOX_BINDING_KEY,
    ]);
    assertAuthenticatedContextCurrent(authContext, 'student message receipt');
    if (stored[STUDENT_CHAT_OUTBOX_BINDING_KEY] !== binding) {
      throw authContextSuperseded('student message receipt');
    }
    const remaining = boundedStudentChatOutbox(stored[STUDENT_CHAT_OUTBOX_KEY])
      .filter((entry) => entry.clientMessageId !== clientMessageId);
    await durableLocalKv.set({ [STUDENT_CHAT_OUTBOX_KEY]: remaining });
    if (remaining.length === 0) {
      await durableLocalKv.remove(STUDENT_CHAT_OUTBOX_BINDING_KEY);
      await chrome.alarms.clear(STUDENT_CHAT_FLUSH_ALARM);
    } else {
      scheduleStudentChatExpiry(remaining);
    }
    assertAuthenticatedContextCurrent(authContext, 'student message receipt');
    return remaining.length;
  });
}

async function discardStudentChatOutbox() {
  return mutateStudentChatOutbox(async () => {
    await durableLocalKv.set({ [STUDENT_CHAT_OUTBOX_KEY]: [] });
    await durableLocalKv.remove(STUDENT_CHAT_OUTBOX_BINDING_KEY);
    await chrome.alarms.clear(STUDENT_CHAT_FLUSH_ALARM);
  });
}

function discardStudentChatOutboxForAuth(authContext) {
  const expectedBinding = monitoringEventAuthBindingForContext(authContext);
  return mutateStudentChatOutbox(async () => {
    assertAuthenticatedContextCurrent(authContext, 'student message conditional discard');
    const stored = await durableLocalKv.get([
      STUDENT_CHAT_OUTBOX_KEY,
      STUDENT_CHAT_OUTBOX_BINDING_KEY,
    ]);
    assertAuthenticatedContextCurrent(authContext, 'student message conditional discard');
    if (!expectedBinding || stored[STUDENT_CHAT_OUTBOX_BINDING_KEY] !== expectedBinding) {
      return false;
    }
    await durableLocalKv.set({ [STUDENT_CHAT_OUTBOX_KEY]: [] });
    assertAuthenticatedContextCurrent(authContext, 'student message conditional discard');
    await durableLocalKv.remove(STUDENT_CHAT_OUTBOX_BINDING_KEY);
    await chrome.alarms.clear(STUDENT_CHAT_FLUSH_ALARM);
    assertAuthenticatedContextCurrent(authContext, 'student message conditional discard');
    return true;
  });
}

function compactStudentChatStorageOnly(nowValue = Date.now()) {
  return mutateStudentChatOutbox(async () => {
    const stored = await durableLocalKv.get([
      STUDENT_CHAT_OUTBOX_KEY,
      STUDENT_CHAT_OUTBOX_BINDING_KEY,
    ]);
    const compacted = boundedStudentChatOutbox(stored[STUDENT_CHAT_OUTBOX_KEY], nowValue);
    await durableLocalKv.set({ [STUDENT_CHAT_OUTBOX_KEY]: compacted });
    if (compacted.length === 0) {
      await durableLocalKv.remove(STUDENT_CHAT_OUTBOX_BINDING_KEY);
      await chrome.alarms.clear(STUDENT_CHAT_FLUSH_ALARM);
    } else {
      scheduleStudentChatExpiry(compacted, nowValue);
    }
    return compacted;
  });
}

function boundChatAckOutbox(entries, nowValue = Date.now()) {
  return boundCommandAckOutbox(entries, nowValue);
}

function scheduleChatAckExpiry(entries, nowValue = Date.now()) {
  const expiries = (Array.isArray(entries) ? entries : [])
    .map((ack) => Number(ack?.queuedAt || 0) + COMMAND_ACK_MAX_AGE_MS + 1)
    .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > nowValue);
  if (expiries.length === 0) return;
  scheduleChatAckFlush(Math.max(1000, Math.min(...expiries) - nowValue));
}

function compactStudentChatOutbox(authContext) {
  const binding = monitoringEventAuthBindingForContext(authContext);
  return mutateStudentChatOutbox(async () => {
    assertAuthenticatedContextCurrent(authContext, 'student message compaction');
    const stored = await durableLocalKv.get([
      STUDENT_CHAT_OUTBOX_KEY,
      STUDENT_CHAT_OUTBOX_BINDING_KEY,
    ]);
    assertAuthenticatedContextCurrent(authContext, 'student message compaction');
    if (!binding || stored[STUDENT_CHAT_OUTBOX_BINDING_KEY] !== binding) return null;
    const compacted = boundedStudentChatOutbox(stored[STUDENT_CHAT_OUTBOX_KEY]);
    await durableLocalKv.set({ [STUDENT_CHAT_OUTBOX_KEY]: compacted });
    assertAuthenticatedContextCurrent(authContext, 'student message compaction');
    if (compacted.length === 0) {
      await durableLocalKv.remove(STUDENT_CHAT_OUTBOX_BINDING_KEY);
      await chrome.alarms.clear(STUDENT_CHAT_FLUSH_ALARM);
    } else {
      scheduleStudentChatExpiry(compacted);
    }
    assertAuthenticatedContextCurrent(authContext, 'student message compaction');
    return compacted;
  });
}

function studentChatRetryDelay(attempts) {
  return STUDENT_CHAT_RETRY_DELAYS_MS[Math.min(
    Math.max(0, Number(attempts || 1) - 1),
    STUDENT_CHAT_RETRY_DELAYS_MS.length - 1,
  )];
}

function scheduleStudentChatExpiry(entries, nowValue = Date.now()) {
  const expiries = (Array.isArray(entries) ? entries : [])
    .map((entry) => Number(entry?.queuedAt || 0) + STUDENT_CHAT_MAX_AGE_MS + 1)
    .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > nowValue);
  if (expiries.length === 0) return;
  scheduleStudentChatFlush(Math.max(1000, Math.min(...expiries) - nowValue));
}

function assertStudentChatSessionCurrent(entry, authContext, reason = 'student message session') {
  assertAuthenticatedContextCurrent(authContext, reason);
  const sessionId = String(entry?.sessionId || '').trim();
  if (!sessionId || !activeTeachingSessionIds().includes(sessionId)) {
    const error = new Error('Student message belongs to a retired teaching session');
    error.code = 'STUDENT_CHAT_SESSION_RETIRED';
    throw error;
  }
  return sessionId;
}

async function discardRetiredStudentChatEntry(entry, authContext) {
  await removeDeliveredStudentChatEntry(entry.clientMessageId, authContext);
  assertAuthenticatedContextCurrent(authContext, 'retired student message removal');
  await notifyStudentChatStatus(entry, 'Failed', {
    errorCode: 'STUDENT_CHAT_SESSION_RETIRED',
  }, authContext);
  return {
    success: false,
    queued: false,
    dropped: true,
    clientMessageId: entry.clientMessageId,
    status: 'Failed',
    errorCode: 'STUDENT_CHAT_SESSION_RETIRED',
  };
}

async function deliverStudentChatEntry(rawEntry, authContext) {
  assertAuthenticatedContextCurrent(authContext, 'student message delivery');
  const binding = monitoringEventAuthBindingForContext(authContext);
  const entry = normalizeStudentChatEntry(rawEntry);
  if (!entry || entry.binding !== binding) throw authContextSuperseded('student message delivery');
  let attempted = entry;
  try {
    assertStudentChatSessionCurrent(entry, authContext, 'student message delivery');
    const attemptStatus = entry.attempts > 0 ? 'Retrying' : 'Sending';
    await notifyStudentChatStatus(entry, attemptStatus, {}, authContext);
    assertStudentChatSessionCurrent(entry, authContext, 'student message status');
    attempted = await updateStudentChatEntry(entry.clientMessageId, {
      attempts: entry.attempts + 1,
      lastAttemptAt: Date.now(),
      status: entry.attempts > 0 ? 'retrying' : 'sending',
      errorCode: null,
    }, authContext);
    assertStudentChatSessionCurrent(attempted, authContext, 'student message persistence');
    assertAuthenticatedContextCurrent(authContext, 'student message transmission');
    assertStudentChatSessionCurrent(attempted, authContext, 'student message transmission');
    const response = await fetchWithBackoff(
      `${authContext.serverOrigin}/api/student/send-message`,
      {
        method: 'POST',
        headers: buildDeviceAuthHeaders(authContext),
        body: JSON.stringify({
          clientMessageId: attempted.clientMessageId,
          message: attempted.message,
          messageType: attempted.messageType,
          sessionId: attempted.sessionId,
        }),
        signal: authContext.signal,
      },
      {
        context: 'student message',
        maxAttempts: 1,
        respectGlobalBackoff: false,
      },
    );
    assertAuthenticatedContextCurrent(authContext, 'student message response');
    assertStudentChatSessionCurrent(attempted, authContext, 'student message response');
    const data = await response.json().catch(() => ({}));
    assertAuthenticatedContextCurrent(authContext, 'student message response body');
    assertStudentChatSessionCurrent(attempted, authContext, 'student message response body');
    if (response.ok
      && data?.delivered === true
      && String(data.clientMessageId || '') === attempted.clientMessageId
      && String(data.messageId || '').trim()) {
      await removeDeliveredStudentChatEntry(attempted.clientMessageId, authContext);
      await notifyStudentChatStatus(attempted, 'Delivered', {
        messageId: String(data.messageId),
        duplicate: data.duplicate === true,
      }, authContext);
      return {
        success: true,
        queued: false,
        clientMessageId: attempted.clientMessageId,
        messageId: String(data.messageId),
        duplicate: data.duplicate === true,
        status: 'Delivered',
      };
    }

    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    const errorCode = retryable ? 'STUDENT_CHAT_RETRY_SCHEDULED' : 'STUDENT_CHAT_REJECTED';
    const status = retryable ? 'retrying' : 'failed';
    const updated = await updateStudentChatEntry(attempted.clientMessageId, {
      status,
      errorCode,
    }, authContext);
    await notifyStudentChatStatus(
      updated,
      retryable ? 'Retrying' : 'Failed',
      { errorCode },
      authContext,
    );
    if (retryable) scheduleStudentChatFlush(studentChatRetryDelay(updated.attempts));
    return {
      success: retryable,
      queued: retryable,
      clientMessageId: attempted.clientMessageId,
      status: retryable ? 'Retrying' : 'Failed',
      errorCode,
    };
  } catch (error) {
    if (isAuthContextCancellation(error)) throw error;
    if (error?.code === 'STUDENT_CHAT_SESSION_RETIRED') {
      return discardRetiredStudentChatEntry(attempted, authContext);
    }
    const updated = await updateStudentChatEntry(attempted.clientMessageId, {
      status: 'retrying',
      errorCode: 'STUDENT_CHAT_RETRY_SCHEDULED',
    }, authContext);
    await notifyStudentChatStatus(updated, 'Retrying', {
      errorCode: 'STUDENT_CHAT_RETRY_SCHEDULED',
    }, authContext);
    scheduleStudentChatFlush(studentChatRetryDelay(updated.attempts));
    return {
      success: true,
      queued: true,
      clientMessageId: attempted.clientMessageId,
      status: 'Retrying',
      errorCode: 'STUDENT_CHAT_RETRY_SCHEDULED',
    };
  }
}

async function sendLegacyStudentChatMessage(raw, authContext, sessionId) {
  const clientMessageId = String(raw.clientMessageId || '').trim()
    || generateStudentChatClientMessageId();
  const statusEntry = { clientMessageId };
  await notifyStudentChatStatus(statusEntry, 'Sending', {}, authContext);
  try {
    assertAuthenticatedContextCurrent(authContext, 'legacy student message transmission');
    const response = await fetchWithBackoff(
      `${authContext.serverOrigin}/api/student/send-message`,
      {
        method: 'POST',
        headers: buildDeviceAuthHeaders(authContext),
        body: JSON.stringify({
          message: String(raw.message || '').trim(),
          messageType: raw.messageType === 'question' ? 'question' : 'message',
          sessionId,
        }),
        signal: authContext.signal,
      },
      {
        context: 'legacy student message',
        maxAttempts: 1,
        respectGlobalBackoff: false,
      },
    );
    assertAuthenticatedContextCurrent(authContext, 'legacy student message response');
    const data = await response.json().catch(() => ({}));
    assertAuthenticatedContextCurrent(authContext, 'legacy student message response body');
    if (!response.ok) {
      await notifyStudentChatStatus(statusEntry, 'Failed', {
        errorCode: 'STUDENT_CHAT_REJECTED',
      }, authContext);
      return {
        success: false,
        queued: false,
        clientMessageId,
        status: 'Failed',
        errorCode: 'STUDENT_CHAT_REJECTED',
      };
    }
    const messageId = String(data.messageId || '').trim() || null;
    await notifyStudentChatStatus(statusEntry, 'Delivered', { messageId }, authContext);
    return {
      success: true,
      queued: false,
      clientMessageId,
      messageId,
      status: 'Delivered',
      legacy: true,
    };
  } catch (error) {
    if (isAuthContextCancellation(error)) throw error;
    await notifyStudentChatStatus(statusEntry, 'Failed', {
      errorCode: 'STUDENT_CHAT_UNAVAILABLE',
    }, authContext);
    return {
      success: false,
      queued: false,
      clientMessageId,
      status: 'Failed',
      errorCode: 'STUDENT_CHAT_UNAVAILABLE',
    };
  }
}

async function queueAndSendStudentChatMessage(raw = {}, expectedAuthContext = null) {
  const authContext = expectedAuthContext || captureAuthenticatedContext('student message');
  assertAuthenticatedContextCurrent(authContext, 'student message');
  const message = String(raw.message || '').trim();
  if (!message || message.length > 500) {
    const error = new Error(message ? 'Message is too long' : 'Message is required');
    error.code = 'STUDENT_CHAT_INVALID';
    throw error;
  }
  const activeSessionIds = activeTeachingSessionIds();
  const requestedSessionId = String(raw.sessionId || '').trim();
  if (!requestedSessionId || !activeSessionIds.includes(requestedSessionId)) {
    const error = new Error('No exact active class session for messaging');
    error.code = 'STUDENT_CHAT_SESSION_REQUIRED';
    throw error;
  }
  if (!hasNegotiatedCapability('studentChatIdempotencyV1', authContext)) {
    return sendLegacyStudentChatMessage(raw, authContext, requestedSessionId);
  }
  const entry = await persistStudentChatEntry({
    clientMessageId: String(raw.clientMessageId || '').trim()
      || generateStudentChatClientMessageId(),
    message,
    messageType: raw.messageType,
    sessionId: requestedSessionId,
    queuedAt: Date.now(),
    status: 'sending',
  }, authContext);
  assertAuthenticatedContextCurrent(authContext, 'student message queued');
  return deliverStudentChatEntry(entry, authContext);
}

async function flushStudentChatOutbox() {
  if (!hasStudentAuth()) return;
  let authContext;
  try {
    authContext = captureAuthenticatedContext('student message retry');
  } catch (error) {
    if (isAuthContextCancellation(error)) return;
    throw error;
  }
  const binding = monitoringEventAuthBindingForContext(authContext);
  if (!binding) return;
  const activeFlush = studentChatFlushInFlight;
  if (activeFlush) {
    if (activeFlush.binding === binding) return activeFlush.promise;
    // A global boolean allowed a B alarm to be consumed while an aborted A
    // request was still settling. Chain one exact B pass after A so the new
    // outbox receives its bounded retry instead of waiting for its 30-minute
    // retention alarm.
    // Also retain a durable near-term alarm in case MV3 suspends before the
    // in-memory handoff continuation runs.
    scheduleStudentChatFlush(1000);
    return activeFlush.promise.catch(() => undefined).then(() => {
      assertAuthenticatedContextCurrent(authContext, 'student message retry handoff');
      return flushStudentChatOutbox();
    }).catch((error) => {
      if (!isAuthContextCancellation(error)) {
        scheduleStudentChatFlush(STUDENT_CHAT_RETRY_DELAYS_MS[0]);
      }
    });
  }
  const owner = { binding, promise: null };
  const run = (async () => {
    try {
      if (!hasNegotiatedCapability('studentChatIdempotencyV1', authContext)) {
        await discardStudentChatOutboxForAuth(authContext);
        return;
      }
      const entries = await compactStudentChatOutbox(authContext);
      assertAuthenticatedContextCurrent(authContext, 'student message retry');
      if (!entries) return;
      for (const entry of entries) {
        assertAuthenticatedContextCurrent(authContext, 'student message retry');
        if (entry.status === 'failed') continue;
        const result = await deliverStudentChatEntry(entry, authContext);
        if (result?.queued) break;
      }
    } catch (error) {
      if (!isAuthContextCancellation(error)) {
        scheduleStudentChatFlush(STUDENT_CHAT_RETRY_DELAYS_MS[0]);
      }
    }
  })();
  owner.promise = run.finally(() => {
    if (studentChatFlushInFlight === owner) studentChatFlushInFlight = null;
  });
  studentChatFlushInFlight = owner;
  return owner.promise;
}

function generateMonitoringEventId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function monitoringEventAuthBindingForContext(context) {
  if (
    !context?.authContextId
    || !context.deviceId
    || !context.studentId
    || !context.studentSessionId
  ) return null;
  // This is a local correlation guard, not an authentication primitive. The
  // random context id partitions every durable outbox without persisting a
  // second copy or derived fingerprint of the bearer credential.
  return [
    'v3',
    context.authContextId,
    context.schoolId || 'school',
    context.studentId,
    context.studentSessionId,
    context.deviceId,
  ].join(':');
}

function monitoringEventAuthBinding() {
  try {
    return monitoringEventAuthBindingForContext(captureAuthenticatedContext('monitoring binding'));
  } catch {
    return null;
  }
}

let retiredExactBoundStorageCleanupMutation = Promise.resolve();

function cleanupRetiredExactBoundStorage(authContext, reason = 'authority adoption') {
  assertAuthenticatedContextCurrent(authContext, reason);
  const expectedBinding = monitoringEventAuthBindingForContext(authContext);
  const expectedLicenseScope = licenseScopeForAuthContext(authContext);
  if (!expectedBinding) throw authContextSuperseded(reason);
  const priorMutations = [
    retiredExactBoundStorageCleanupMutation,
    monitoringEventMutation,
    commandAckMutation,
    chatAckMutation,
    studentChatMutation,
    tabSnapshotMutation,
    messageInboxMutation,
    fabStateMutation,
    classroomOverlayMutation,
    schoolPolicyMutation,
    schoolSettingsMutation,
    classroomStateApplicationTail,
  ].map((pending) => Promise.resolve(pending).catch(() => undefined));
  const cleanup = Promise.all(priorMutations).then(async () => {
    assertAuthenticatedContextCurrent(authContext, reason);
    const keys = [
      MONITORING_EVENT_OUTBOX_KEY,
      MONITORING_EVENT_AUTH_BINDING_KEY,
      COMMAND_ACK_OUTBOX_KEY,
      COMMAND_ACK_BINDING_KEY,
      CHAT_ACK_OUTBOX_KEY,
      CHAT_ACK_BINDING_KEY,
      STUDENT_CHAT_OUTBOX_KEY,
      STUDENT_CHAT_OUTBOX_BINDING_KEY,
      TAB_SNAPSHOT_STORAGE_KEY,
      MESSAGE_INBOX_STORAGE_KEY,
      MESSAGE_INBOX_BINDING_KEY,
      MESSAGE_INBOX_DEDUP_KEY,
      'fabChatMessages',
      'fabChatClosed',
      PENDING_CHECK_IN_KEY,
      FAB_STATE_STORAGE_KEY,
      FAB_CONTEXT_STORAGE_KEY,
      FAB_CHAT_CONTEXT_STORAGE_KEY,
      CLASSROOM_OVERLAY_STORAGE_KEY,
      'handRaised',
      'messagingEnabled',
      'handRaisingEnabled',
      'globalBlockedDomains',
      GLOBAL_BLOCKED_DOMAINS_SCOPE_KEY,
      SCHOOL_SETTINGS_CACHE_KEY,
      SCHOOL_SETTINGS_FETCHED_AT_KEY,
      SCHOOL_SETTINGS_SCOPE_KEY,
      'licenseActive',
      'planStatus',
      'licenseDisabledAt',
      LICENSE_STATE_SCOPE_KEY,
      LICENSE_LAST_VERIFIED_AT_KEY,
    ];
    const stored = await durableLocalKv.get(keys);
    assertAuthenticatedContextCurrent(authContext, reason);
    const updates = {};
    const removals = [];
    const alarmsToClear = [];
    const purgePair = (outboxKey, bindingKey, alarmName = null) => {
      const entries = stored[outboxKey];
      const storedBinding = stored[bindingKey];
      const containsData = Array.isArray(entries) ? entries.length > 0 : Boolean(entries);
      if ((storedBinding && storedBinding !== expectedBinding) || (!storedBinding && containsData)) {
        updates[outboxKey] = [];
        removals.push(bindingKey);
        if (alarmName) alarmsToClear.push(alarmName);
      }
    };
    if (
      stored[LICENSE_STATE_SCOPE_KEY] !== expectedLicenseScope
      && (
        stored[LICENSE_STATE_SCOPE_KEY]
        || stored.licenseActive !== undefined
        || stored.planStatus !== undefined
        || stored.licenseDisabledAt !== undefined
      )
    ) {
      removals.push(
        'licenseActive',
        'planStatus',
        'licenseDisabledAt',
        LICENSE_STATE_SCOPE_KEY,
        LICENSE_LAST_VERIFIED_AT_KEY,
      );
    }
    purgePair(
      MONITORING_EVENT_OUTBOX_KEY,
      MONITORING_EVENT_AUTH_BINDING_KEY,
      MONITORING_EVENT_FLUSH_ALARM,
    );
    purgePair(COMMAND_ACK_OUTBOX_KEY, COMMAND_ACK_BINDING_KEY, COMMAND_ACK_FLUSH_ALARM);
    purgePair(CHAT_ACK_OUTBOX_KEY, CHAT_ACK_BINDING_KEY, CHAT_ACK_FLUSH_ALARM);
    purgePair(
      STUDENT_CHAT_OUTBOX_KEY,
      STUDENT_CHAT_OUTBOX_BINDING_KEY,
      STUDENT_CHAT_FLUSH_ALARM,
    );
    if (
      stored[TAB_SNAPSHOT_STORAGE_KEY]
      && stored[TAB_SNAPSHOT_STORAGE_KEY].binding !== expectedBinding
    ) {
      removals.push(TAB_SNAPSHOT_STORAGE_KEY);
      currentTabSnapshotRevision = 0;
      lastKnownTabs = [];
      lastKnownTabsAuthBinding = null;
    }
    const inboxContainsData = [
      stored[MESSAGE_INBOX_STORAGE_KEY],
      stored[MESSAGE_INBOX_DEDUP_KEY],
      stored.fabChatMessages,
    ].some((value) => Array.isArray(value) && value.length > 0)
      || stored.fabChatClosed === true;
    if (
      (stored[MESSAGE_INBOX_BINDING_KEY]
        && stored[MESSAGE_INBOX_BINDING_KEY] !== expectedBinding)
      || (!stored[MESSAGE_INBOX_BINDING_KEY] && inboxContainsData)
    ) {
      updates[MESSAGE_INBOX_STORAGE_KEY] = [];
      updates[MESSAGE_INBOX_DEDUP_KEY] = [];
      updates.fabChatMessages = [];
      updates.fabChatClosed = false;
      updates[MESSAGE_INBOX_BINDING_KEY] = expectedBinding;
    }
    const expectedFabBinding = fabIdentityBinding();
    const storedFabContext = stored[FAB_CONTEXT_STORAGE_KEY];
    const storedChatContext = stored[FAB_CHAT_CONTEXT_STORAGE_KEY];
    const storedOverlay = stored[CLASSROOM_OVERLAY_STORAGE_KEY];
    const retiredFabState = Boolean(stored[FAB_STATE_STORAGE_KEY])
      && (!expectedFabBinding || storedFabContext?.binding !== expectedFabBinding);
    const retiredChatState = (
      (Array.isArray(stored.fabChatMessages) && stored.fabChatMessages.length > 0)
      || stored.fabChatClosed === true
    ) && (!expectedFabBinding || storedChatContext?.binding !== expectedFabBinding);
    const retiredOverlay = Boolean(storedOverlay)
      && (!expectedFabBinding || storedOverlay.binding !== expectedFabBinding);
    const retiredUnboundFabValues = (
      stored.handRaised === true
      || stored.messagingEnabled !== undefined
      || stored.handRaisingEnabled !== undefined
    ) && (!expectedFabBinding || storedFabContext?.binding !== expectedFabBinding);
    if (retiredFabState || retiredChatState || retiredOverlay || retiredUnboundFabValues) {
      updates[FAB_STATE_STORAGE_KEY] = null;
      updates[FAB_CONTEXT_STORAGE_KEY] = null;
      updates[FAB_CHAT_CONTEXT_STORAGE_KEY] = null;
      updates[CLASSROOM_OVERLAY_STORAGE_KEY] = null;
      updates.fabChatMessages = [];
      updates.fabChatClosed = true;
      updates.handRaised = false;
      updates.messagingEnabled = false;
      updates.handRaisingEnabled = false;
      alarmsToClear.push(CLASSROOM_OVERLAY_EXPIRY_ALARM);
      currentFabState = null;
    }
    const pendingCheckIn = stored[PENDING_CHECK_IN_KEY];
    if (
      pendingCheckIn
      && (pendingCheckIn.binding !== expectedBinding
        || Number(pendingCheckIn.expiresAt || 0) <= Date.now())
    ) {
      removals.push(PENDING_CHECK_IN_KEY);
      alarmsToClear.push(PENDING_CHECK_IN_EXPIRY_ALARM);
    }
    const expectedSchoolScope = schoolPolicyScopeForAuthContext(authContext);
    const storedSchoolPolicy = classifyStoredSchoolPolicy(stored, expectedSchoolScope);
    if (storedSchoolPolicy.status === 'matched') {
      globalBlockedDomains = storedSchoolPolicy.domains;
      globalBlockedDomainsStateTrusted = true;
      globalBlockedDomainsScope = expectedSchoolScope;
    } else if (storedSchoolPolicy.status === 'mismatch') {
      updates.globalBlockedDomains = [];
      if (expectedSchoolScope) updates[GLOBAL_BLOCKED_DOMAINS_SCOPE_KEY] = expectedSchoolScope;
      else removals.push(GLOBAL_BLOCKED_DOMAINS_SCOPE_KEY);
      globalBlockedDomains = [];
      globalBlockedDomainsStateTrusted = true;
      globalBlockedDomainsScope = expectedSchoolScope;
      await composeDynamicRules(['school'], { globalBlockedDomains: [] });
      assertAuthenticatedContextCurrent(authContext, reason);
    } else {
      // A legacy unscoped or malformed policy has no safe tenant owner here.
      // Keep Chrome's surviving rules fail-closed until worker-wake migration
      // proves the prior persisted owner or the server supplies a fresh list.
      globalBlockedDomains = [];
      globalBlockedDomainsStateTrusted = false;
      globalBlockedDomainsScope = null;
    }
    if (!expectedSchoolScope || stored[SCHOOL_SETTINGS_SCOPE_KEY] !== expectedSchoolScope) {
      removals.push(
        SCHOOL_SETTINGS_CACHE_KEY,
        SCHOOL_SETTINGS_FETCHED_AT_KEY,
        SCHOOL_SETTINGS_SCOPE_KEY,
      );
      schoolSettings = null;
      schoolSettingsFetchedAt = 0;
      schoolSettingsScope = null;
    }
    if (Object.keys(updates).length > 0) {
      await durableLocalKv.set(updates);
      assertAuthenticatedContextCurrent(authContext, reason);
    }
    if (removals.length > 0) {
      await durableLocalKv.remove([...new Set(removals)]);
      assertAuthenticatedContextCurrent(authContext, reason);
    }
    await Promise.all([...new Set(alarmsToClear)].map((name) => (
      Promise.resolve(chrome.alarms.clear(name)).catch(() => false)
    )));
    await ensureRestrictionSsoVisitStateForContext(authContext).catch(async () => {
      await clearRestrictionSsoVisitState().catch(() => {});
    });
    assertAuthenticatedContextCurrent(authContext, reason);
    return {
      purgedKeys: [...new Set([...Object.keys(updates), ...removals])],
      binding: expectedBinding,
    };
  });
  retiredExactBoundStorageCleanupMutation = cleanup.catch(() => undefined);
  // Serialize every exact-bound writer behind the transition cleanup. Future
  // writes chain from these globals, so a newly adopted identity cannot race
  // the physical removal of a retired identity's payloads.
  monitoringEventMutation = retiredExactBoundStorageCleanupMutation;
  commandAckMutation = retiredExactBoundStorageCleanupMutation;
  chatAckMutation = retiredExactBoundStorageCleanupMutation;
  studentChatMutation = retiredExactBoundStorageCleanupMutation;
  tabSnapshotMutation = retiredExactBoundStorageCleanupMutation;
  messageInboxMutation = retiredExactBoundStorageCleanupMutation;
  fabStateMutation = retiredExactBoundStorageCleanupMutation;
  classroomOverlayMutation = retiredExactBoundStorageCleanupMutation;
  schoolPolicyMutation = retiredExactBoundStorageCleanupMutation;
  return cleanup;
}

function messageInboxAuthBinding() {
  // The monitoring binding already captures the exact student, device, and
  // token-backed session without persisting the raw credential.
  return monitoringEventAuthBinding();
}

function assertMessageInboxOperationCurrent(options = {}, reason = 'message inbox mutation') {
  const authContext = options.authContext || null;
  if (!authContext) return messageInboxAuthBinding();
  assertAuthenticatedContextCurrent(authContext, reason);
  const contextBinding = monitoringEventAuthBindingForContext(authContext);
  const currentBinding = authContext.allowCommitPending === true
    ? monitoringEventAuthBindingForContext(authContext)
    : messageInboxAuthBinding();
  if (
    !contextBinding
    || (Object.prototype.hasOwnProperty.call(options, 'expectedBinding')
      && options.expectedBinding !== contextBinding)
    || contextBinding !== currentBinding
  ) {
    throw authContextSuperseded(reason);
  }
  if (options.sourceMessage) {
    const binding = assertCurrentStudentBinding(
      options.sourceMessage,
      reason,
      { authContext },
    );
    assertBindingMatchesAuthContext(binding, authContext, reason);
  }
  return contextBinding;
}

async function clearSupersededMessageInboxWrite(retiredBinding) {
  if (!retiredBinding) return;
  const stored = await kv.get([
    MESSAGE_INBOX_STORAGE_KEY,
    MESSAGE_INBOX_BINDING_KEY,
    MESSAGE_INBOX_DEDUP_KEY,
  ]);
  // Never overwrite a newer authenticated context's inbox. All inbox writers
  // are serialized, and this equality also protects against an external
  // storage event replacing the tuple while the retired write was in flight.
  if (stored[MESSAGE_INBOX_BINDING_KEY] !== retiredBinding) return;
  const activeBinding = messageInboxAuthBinding();
  await kv.set({
    [MESSAGE_INBOX_STORAGE_KEY]: [],
    [MESSAGE_INBOX_DEDUP_KEY]: [],
    fabChatMessages: [],
    fabChatClosed: false,
    ...(activeBinding ? { [MESSAGE_INBOX_BINDING_KEY]: activeBinding } : {}),
  });
  if (!activeBinding) await kv.remove(MESSAGE_INBOX_BINDING_KEY);
}

async function setMessageInboxStorageFenced(updates, options = {}, reason = 'message inbox write') {
  const expectedBinding = assertMessageInboxOperationCurrent(options, reason);
  await kv.set(updates);
  try {
    assertMessageInboxOperationCurrent(options, reason);
  } catch (error) {
    if (isAuthContextCancellation(error) || error?.code === 'STUDENT_BINDING_MISMATCH') {
      await clearSupersededMessageInboxWrite(expectedBinding);
    }
    throw error;
  }
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

function notifyStudentMessageStateCleared(
  reason,
  retiredStudentMessageContext = lastRetiredStudentMessageContext,
) {
  return broadcastToAllTabs('student-message-state-cleared', {
    reason,
    retiredStudentMessageContext: retiredStudentMessageContext
      ? { ...retiredStudentMessageContext }
      : null,
  });
}

async function reconcileMessageInboxIdentityNow(reason = 'identity-check', options = {}) {
  const binding = assertMessageInboxOperationCurrent(options, reason);
  await authBoundNotificationCleanupPromise;
  assertMessageInboxOperationCurrent(options, reason);
  const stored = await kv.get([
    MESSAGE_INBOX_STORAGE_KEY,
    MESSAGE_INBOX_BINDING_KEY,
    MESSAGE_INBOX_DEDUP_KEY,
    'fabChatMessages',
    'fabChatClosed',
  ]);
  assertMessageInboxOperationCurrent(options, reason);
  const storedBinding = stored[MESSAGE_INBOX_BINDING_KEY] || null;
  const bindingChanged = storedBinding !== binding;

  if (!binding || bindingChanged) {
    await setMessageInboxStorageFenced({
      [MESSAGE_INBOX_STORAGE_KEY]: [],
      [MESSAGE_INBOX_DEDUP_KEY]: [],
      fabChatMessages: [],
      fabChatClosed: false,
      ...(binding ? { [MESSAGE_INBOX_BINDING_KEY]: binding } : {}),
    }, options, reason);
    if (!binding) {
      await kv.remove(MESSAGE_INBOX_BINDING_KEY);
      assertMessageInboxOperationCurrent(options, reason);
    }
    if (
      storedBinding
      || (Array.isArray(stored[MESSAGE_INBOX_STORAGE_KEY]) && stored[MESSAGE_INBOX_STORAGE_KEY].length > 0)
      || (Array.isArray(stored.fabChatMessages) && stored.fabChatMessages.length > 0)
    ) {
      await notifyStudentMessageStateCleared(reason);
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

function reconcileMessageInboxIdentity(reason = 'identity-check', options = {}) {
  return enqueueMessageInboxMutation(() => reconcileMessageInboxIdentityNow(reason, options));
}

function persistTeacherMessages(rawMessages, options = {}) {
  return enqueueMessageInboxMutation(async () => {
    const reason = options.reason || 'message-delivery';
    assertMessageInboxOperationCurrent(options, reason);
    const identity = await reconcileMessageInboxIdentityNow(reason, options);
    assertMessageInboxOperationCurrent(options, reason);
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
    await setMessageInboxStorageFenced({
      [MESSAGE_INBOX_STORAGE_KEY]: merged.messages,
      [MESSAGE_INBOX_DEDUP_KEY]: merged.seenIds,
      [MESSAGE_INBOX_BINDING_KEY]: identity.binding,
    }, options, reason);
    assertMessageInboxOperationCurrent(options, reason);
    return merged;
  });
}

function persistHeartbeatPendingMessages(
  rawMessages,
  expectedBinding = messageInboxAuthBinding(),
  options = {},
) {
  // Heartbeat inbox rows must carry a backend-stable id. Do not synthesize an
  // id here: a malformed row repeated on every heartbeat would otherwise be
  // displayed repeatedly.
  return persistTeacherMessages(rawMessages, {
    reason: 'heartbeat-pending-messages',
    expectedBinding,
    ...options,
  });
}

function getCurrentMessageInbox(options = {}) {
  return enqueueMessageInboxMutation(async () => {
    assertMessageInboxOperationCurrent(options, 'message-inbox-read');
    const identity = await reconcileMessageInboxIdentityNow('message-inbox-read', options);
    assertMessageInboxOperationCurrent(options, 'message-inbox-read');
    return identity.messages;
  });
}

function markCurrentMessageInboxRead(options = {}) {
  return enqueueMessageInboxMutation(async () => {
    assertMessageInboxOperationCurrent(options, 'message-inbox-read-state');
    const identity = await reconcileMessageInboxIdentityNow('message-inbox-read-state', options);
    assertMessageInboxOperationCurrent(options, 'message-inbox-read-state');
    if (!identity.binding || !identity.messages.some((message) => message?.read !== true)) {
      return identity.messages;
    }
    const messages = identity.messages.map((message) => ({ ...message, read: true }));
    await setMessageInboxStorageFenced(
      { [MESSAGE_INBOX_STORAGE_KEY]: messages },
      options,
      'message-inbox-read-state',
    );
    return messages;
  });
}

function clearCurrentMessageInboxDisplay(options = {}) {
  return enqueueMessageInboxMutation(async () => {
    assertMessageInboxOperationCurrent(options, 'message-inbox-clear-display');
    const identity = await reconcileMessageInboxIdentityNow('message-inbox-clear-display', options);
    assertMessageInboxOperationCurrent(options, 'message-inbox-clear-display');
    if (!identity.binding) return [];
    // Keep the bounded seen-id ledger so a backend retry cannot resurrect a
    // message the student deliberately cleared from the display.
    await setMessageInboxStorageFenced(
      { [MESSAGE_INBOX_STORAGE_KEY]: [] },
      options,
      'message-inbox-clear-display',
    );
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
    await notifyStudentMessageStateCleared(reason);
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
    const when = Date.now() + Math.max(MONITORING_EVENT_FLUSH_MS, normalizedDelay);
    if (
      !existing
      || Number(existing.scheduledTime || 0) <= Date.now()
      || existing.scheduledTime > when
    ) {
      chrome.alarms.create(MONITORING_EVENT_FLUSH_ALARM, { when });
    }
  });
}

function enqueueMonitoringEvent(type, metadata = {}, options = {}) {
  if (!hasStudentAuth() && !options.allowWithoutAuth) return Promise.resolve(false);
  let authContext;
  try {
    authContext = options.authContext || captureAuthenticatedContext('monitoring event');
    assertAuthenticatedContextCurrent(authContext, 'monitoring event');
  } catch {
    return Promise.resolve(false);
  }
  const authBinding = monitoringEventAuthBindingForContext(authContext);
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
    assertAuthenticatedContextCurrent(authContext, 'monitoring event persistence');
    const stored = await kv.get([
      MONITORING_EVENT_OUTBOX_KEY,
      MONITORING_EVENT_DROPPED_KEY,
      MONITORING_EVENT_AUTH_BINDING_KEY,
    ]);
    assertAuthenticatedContextCurrent(authContext, 'monitoring event persistence');
    const storedEntries = Array.isArray(stored[MONITORING_EVENT_OUTBOX_KEY])
      ? stored[MONITORING_EVENT_OUTBOX_KEY]
      : [];
    const bindingMatches = stored[MONITORING_EVENT_AUTH_BINDING_KEY] === authBinding;
    const discardedForIdentityChange = storedEntries.length > 0 && !bindingMatches
      ? storedEntries.length
      : 0;
    const bounded = RuntimeCore.boundEventOutbox(bindingMatches ? storedEntries : [], event);
    assertAuthenticatedContextCurrent(authContext, 'monitoring event persistence');
    await kv.set({
      [MONITORING_EVENT_OUTBOX_KEY]: bounded.entries,
      [MONITORING_EVENT_DROPPED_KEY]: Number(stored[MONITORING_EVENT_DROPPED_KEY] || 0)
        + discardedForIdentityChange
        + bounded.dropped,
      [MONITORING_EVENT_AUTH_BINDING_KEY]: authBinding,
    });
    assertAuthenticatedContextCurrent(authContext, 'monitoring event persistence');
    scheduleMonitoringEventFlush();
    return true;
  }).catch((error) => {
    console.warn('[Monitoring Events] Failed to queue event:', safeDiagnosticError(error));
    return false;
  });
  return monitoringEventMutation;
}

async function removeMonitoringEventBatch(sourceEventIds, expectedAuthContext = null) {
  const acknowledged = new Set(sourceEventIds);
  monitoringEventMutation = monitoringEventMutation.then(async () => {
    if (expectedAuthContext) {
      assertAuthenticatedContextCurrent(expectedAuthContext, 'monitoring event receipt');
    }
    const stored = await kv.get([MONITORING_EVENT_OUTBOX_KEY]);
    if (expectedAuthContext) {
      assertAuthenticatedContextCurrent(expectedAuthContext, 'monitoring event receipt');
    }
    const remaining = (stored[MONITORING_EVENT_OUTBOX_KEY] || [])
      .filter((event) => !acknowledged.has(event?.sourceEventId));
    await kv.set({ [MONITORING_EVENT_OUTBOX_KEY]: remaining });
    if (expectedAuthContext) {
      assertAuthenticatedContextCurrent(expectedAuthContext, 'monitoring event receipt');
    }
    if (remaining.length === 0) await kv.remove(MONITORING_EVENT_AUTH_BINDING_KEY);
    return remaining.length;
  });
  return monitoringEventMutation;
}

async function discardMonitoringEventOutbox(expectedAuthContext = null) {
  monitoringEventMutation = monitoringEventMutation.then(async () => {
    if (expectedAuthContext) {
      assertAuthenticatedContextCurrent(expectedAuthContext, 'monitoring event discard');
    }
    const stored = await kv.get([MONITORING_EVENT_OUTBOX_KEY, MONITORING_EVENT_DROPPED_KEY]);
    if (expectedAuthContext) {
      assertAuthenticatedContextCurrent(expectedAuthContext, 'monitoring event discard');
    }
    const discarded = Array.isArray(stored[MONITORING_EVENT_OUTBOX_KEY])
      ? stored[MONITORING_EVENT_OUTBOX_KEY].length
      : 0;
    await kv.set({
      [MONITORING_EVENT_OUTBOX_KEY]: [],
      [MONITORING_EVENT_DROPPED_KEY]: Number(stored[MONITORING_EVENT_DROPPED_KEY] || 0) + discarded,
    });
    if (expectedAuthContext) {
      assertAuthenticatedContextCurrent(expectedAuthContext, 'monitoring event discard');
    }
    await kv.remove(MONITORING_EVENT_AUTH_BINDING_KEY);
    if (expectedAuthContext) {
      assertAuthenticatedContextCurrent(expectedAuthContext, 'monitoring event discard');
    }
    return discarded;
  });
  return monitoringEventMutation;
}

async function flushMonitoringEventOutbox() {
  if (!hasStudentAuth()) return;
  let authContext;
  try {
    authContext = captureAuthenticatedContext('monitoring event flush');
  } catch {
    return;
  }
  const binding = monitoringEventAuthBindingForContext(authContext);
  if (!binding) return;
  const activeFlush = monitoringEventFlushInFlight;
  if (activeFlush) {
    if (activeFlush.binding === binding) return activeFlush.promise;
    scheduleMonitoringEventFlush(1000);
    return activeFlush.promise.catch(() => undefined).then(() => {
      assertAuthenticatedContextCurrent(authContext, 'monitoring event flush handoff');
      return flushMonitoringEventOutbox();
    }).catch((error) => {
      if (!isAuthContextCancellation(error)) scheduleMonitoringEventFlush(1000);
    });
  }
  const owner = { binding, promise: null };
  const run = (async () => {
    try {
      await monitoringEventMutation;
      assertAuthenticatedContextCurrent(authContext, 'monitoring event flush');
      const stored = await kv.get([MONITORING_EVENT_OUTBOX_KEY, MONITORING_EVENT_AUTH_BINDING_KEY]);
      assertAuthenticatedContextCurrent(authContext, 'monitoring event flush');
      const batch = (stored[MONITORING_EVENT_OUTBOX_KEY] || []).slice(0, 50);
      if (batch.length === 0) {
        chrome.alarms.clear(MONITORING_EVENT_FLUSH_ALARM);
        return;
      }
      const currentBinding = monitoringEventAuthBindingForContext(authContext);
      if (!currentBinding || stored[MONITORING_EVENT_AUTH_BINDING_KEY] !== currentBinding) {
        await discardMonitoringEventOutbox(authContext);
        chrome.alarms.clear(MONITORING_EVENT_FLUSH_ALARM);
        return;
      }

      const payload = { events: batch };
      const headers = buildDeviceAuthHeaders(authContext);
      attachLegacyStudentToken(payload, headers, authContext);
      assertAuthenticatedContextCurrent(authContext, 'monitoring event transmission');
      const response = await fetchWithBackoff(`${authContext.serverOrigin}/api/classpilot/device/events`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: authContext.signal,
      }, {
        context: 'device event',
        maxAttempts: 1,
        retryStatuses: new Set([429, 503]),
      });
      assertAuthenticatedContextCurrent(authContext, 'monitoring event response');

      if (response.status === 429 || response.status === 503) {
        scheduleMonitoringEventFlush();
        return;
      }
      if (response.status === 402) {
        const data = await response.json().catch(() => ({}));
        assertAuthenticatedContextCurrent(authContext, 'monitoring event license response');
        await disableForInactiveLicense(data.planStatus, authContext);
      }

      // A successful batch acknowledges each source event independently. Keep
      // any event omitted from the response queued: ingestion is idempotent, so
      // retrying it is safer than silently losing telemetry after a partial or
      // malformed response. Other non-retryable responses are discarded so one
      // rejected batch cannot permanently block later telemetry.
      let acknowledgedIds = batch.map((event) => event.sourceEventId);
      if (response.ok) {
        const data = await response.json().catch(() => null);
        assertAuthenticatedContextCurrent(authContext, 'monitoring event receipt');
        acknowledgedIds = RuntimeCore.acknowledgedMonitoringEventIds(batch, data);
        if (acknowledgedIds.length === 0) {
          scheduleMonitoringEventFlush();
          return;
        }
      }
      const remaining = await removeMonitoringEventBatch(acknowledgedIds, authContext);
      if (remaining > 0) scheduleMonitoringEventFlush();
    } catch (error) {
      if (!isAuthContextCancellation(error)) {
        console.warn('[Monitoring Events] Flush deferred:', safeDiagnosticError(error));
        scheduleMonitoringEventFlush();
      }
    }
  })();
  owner.promise = run.finally(() => {
    if (monitoringEventFlushInFlight === owner) monitoringEventFlushInFlight = null;
  });
  monitoringEventFlushInFlight = owner;
  return owner.promise;
}

function queueNavigationEvent(eventType, url, title, metadata = {}) {
  if (!currentLicenseIsActive() || trackingState === TRACKING_STATES.OFF || !hasStudentAuth() || !isHttpUrl(url)) {
    return;
  }
  let authContext;
  try {
    authContext = captureAuthenticatedContext('navigation event');
  } catch {
    return;
  }
  const normalizedType = eventType === 'tab_change' ? 'tab_changed' : 'navigation_changed';
  const key = `${normalizedType}:${metadata.tabId ?? 'unknown'}`;
  pendingNavigationEvents.set(key, {
    eventType: normalizedType,
    url,
    title,
    authContext,
  });

  if (navigationDebounceTimers.has(key)) clearTimeout(navigationDebounceTimers.get(key));
  navigationDebounceTimers.set(key, setTimeout(() => {
    const event = pendingNavigationEvents.get(key);
    pendingNavigationEvents.delete(key);
    navigationDebounceTimers.delete(key);
    if (!event || trackingState === TRACKING_STATES.OFF) return;
    try {
      assertAuthenticatedContextCurrent(event.authContext, 'navigation event dispatch');
    } catch {
      return;
    }
    enqueueMonitoringEvent(
      event.eventType,
      { url: event.url, title: event.title },
      { authContext: event.authContext },
    ).catch(() => {});
  }, NAVIGATION_DEBOUNCE_MS));
}

function persistFabChatStateForRequest(message, actionRequest) {
  const allowedStatuses = new Set(['Sending', 'Retrying', 'Delivered', 'Failed']);
  const messages = (Array.isArray(message?.messages) ? message.messages : [])
    .slice(-50)
    .map((entry) => ({
      id: String(entry?.id || '').slice(0, 200) || null,
      clientMessageId: String(entry?.clientMessageId || '').slice(0, 200) || null,
      sessionId: String(entry?.sessionId || actionRequest.sessionId).slice(0, 200),
      sender: entry?.sender === 'teacher' ? 'teacher' : 'student',
      text: String(entry?.text || '').slice(0, 500),
      fromName: String(entry?.fromName || '').slice(0, 100) || null,
      time: Number.isFinite(Number(entry?.time)) ? Number(entry.time) : Date.now(),
      status: allowedStatuses.has(entry?.status) ? entry.status : null,
    }))
    .filter((entry) => entry.text && entry.sessionId === actionRequest.sessionId);
  const options = {
    authContext: actionRequest.authContext,
    expectedBinding: monitoringEventAuthBindingForContext(actionRequest.authContext),
  };
  return enqueueMessageInboxMutation(async () => {
    assertStudentActionRequestCurrent(actionRequest, 'FAB chat state persistence');
    const context = {
      schemaVersion: 1,
      binding: actionRequest.fabBinding,
      teachingSessionId: actionRequest.sessionId,
      activeSessionIds: activeTeachingSessionIds(),
      revision: Number(currentFabState?.revision || 0),
      lifecycleRevision: Number(currentFabState?.lifecycleRevision || 0),
      ownershipRevision: Number(currentFabState?.ownershipRevision || 0),
      ownershipRevisionKnown: currentFabState?.ownershipRevisionKnown === true,
    };
    await setMessageInboxStorageFenced({
      fabChatMessages: messages,
      fabChatClosed: message?.chatClosed === true,
      [FAB_CHAT_CONTEXT_STORAGE_KEY]: context,
    }, options, 'FAB chat state persistence');
    assertStudentActionRequestCurrent(actionRequest, 'FAB chat state persistence');
    return true;
  });
}

function clearPendingNavigationEvents() {
  for (const timer of navigationDebounceTimers.values()) clearTimeout(timer);
  navigationDebounceTimers.clear();
  pendingNavigationEvents.clear();
}

function generateAuthContextId() {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  return `auth_${String(random).replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

function failPrivateRetiredOffscreenAuthority() {
  if (activeLiveViewContext || wsTransportIdentity) return;
  // Share the same close flight used by replacement creation. A delayed
  // retired-context failure must finish closing the old offscreen document
  // before a new authority is allowed to create/authenticate its proxy.
  closeOffscreenDocumentFailPrivate().catch(() => {});
}

function revokeRetiredOffscreenAuthority(liveViewContext, transportIdentity) {
  const messages = [];
  if (liveViewContext) {
    messages.push({
      type: 'STOP_SHARE',
      ...liveViewOffscreenIdentity(liveViewContext),
    });
  }
  if (transportIdentity) {
    messages.push({
      type: 'WS_CLOSE',
      connectionGeneration: transportIdentity.connectionGeneration,
      authContextId: transportIdentity.authContextId,
      serverOrigin: transportIdentity.serverOrigin,
    });
  }
  for (const message of messages) {
    try {
      const result = chrome.runtime?.sendMessage?.(message);
      Promise.resolve(result).then((response) => {
        if (response?.success !== true) failPrivateRetiredOffscreenAuthority();
      }, failPrivateRetiredOffscreenAuthority);
    } catch {
      failPrivateRetiredOffscreenAuthority();
    }
  }
}

function abortActiveAuthContext() {
  if (
    activeAuthContextGeneration === studentAuthMutationGeneration
    && !authContextAbortController.signal.aborted
    && CONFIG.authContextId
    && CONFIG.activeStudentId
    && CONFIG.activeStudentSessionId
  ) {
    lastRetiredStudentMessageContext = Object.freeze({
      authContextId: String(CONFIG.authContextId),
      schoolId: String(CONFIG.schoolId || '').trim() || null,
      studentId: String(CONFIG.activeStudentId),
      studentSessionId: String(CONFIG.activeStudentSessionId),
    });
  }
  const retiredLiveViewContext = activeLiveViewContext;
  const retiredTransportIdentity = wsTransportIdentity;
  // Initiate exact-context revocation before invalidating local pointers. A
  // login that pauses or fails must not leave the prior student's offscreen
  // MediaStream or authenticated socket alive.
  revokeRetiredOffscreenAuthority(retiredLiveViewContext, retiredTransportIdentity);
  try {
    authContextAbortController.abort();
  } catch {
    // AbortController cleanup is best effort; the generation fence is authoritative.
  }
  activeAuthContextGeneration = -1;
  clearPendingNavigationEvents();
  lastKnownTabs = [];
  lastKnownTabsAuthBinding = null;
  currentTabSnapshotRevision = 0;
  cameraActiveTabs.clear();
  cameraActive = false;
  // Teacher-broadcast viewing state is student authority, not a school-global
  // transport flag. Do not let a new identity send a leave for the retired
  // student's broadcast session over its new socket.
  teacherBroadcastActive = false;
  teacherBroadcastSessionId = null;
  currentFabState = null;
  lastClassroomStateOutcome = 'pending';
  lastClassroomStateAckRevision = 0;
  lastClassroomStateAckAuthBinding = null;
  resetLicenseStateForAuthorityTransition();
  // A control-cleanup retry belongs to the retired exact license scope. The
  // alarm callback independently validates its durable scope in case the
  // event was already queued before this best-effort clear completed.
  try {
    Promise.resolve(chrome.alarms.clear(LICENSE_CONTROL_CLEANUP_ALARM)).catch(() => {});
    Promise.resolve(chrome.alarms.clear(CLASSROOM_STATE_RECONCILE_ALARM)).catch(() => {});
  } catch {
    // Alarm scope validation remains authoritative.
  }
  trackingState = TRACKING_STATES.OFF;
  persistedMonitoringState = {
    state: TRACKING_STATES.OFF,
    changedAt: Date.now(),
    reason: 'authority_transition',
  };
  persistedMonitoringStateScope = null;
  scheduleHeartbeat(null);
  scheduleScreenshotCapture(false);
  schoolSettings = null;
  schoolSettingsFetchedAt = 0;
  schoolSettingsScope = null;
  schoolMaxTabs = null;
  currentMaxTabs = effectiveTabLimit();
  resetStudentControlRevisionAuthority();
  const hadAuthBoundNotifications = activeAuthBoundNotificationIds.size > 0;
  const notificationCleanupWasInFlight = Boolean(authBoundNotificationCleanupInFlight);
  const notificationInventoryNeededReconciliation = !authBoundNotificationInventoryReconciled;
  activeAuthBoundNotificationIds.clear();
  if (
    hadAuthBoundNotifications
    || notificationCleanupWasInFlight
    || notificationInventoryNeededReconciliation
  ) {
    authBoundNotificationInventoryReconciled = false;
    authBoundNotificationCleanupRetryAt = 0;
  }
  // A transition that overlaps a pass must chain a fresh current-owner pass;
  // merely joining a B-prefix snapshot could mark the inventory reconciled
  // after C becomes current and leave B's notification visible under C.
  const forceNotificationCleanup = hadAuthBoundNotifications
    || notificationCleanupWasInFlight
    || notificationInventoryNeededReconciliation;
  authBoundNotificationCleanupPromise = ensureAuthBoundNotificationInventory({
    force: forceNotificationCleanup,
  });
  negotiatedProtocolState = null;
  activeLiveViewContext = null;
  activeLiveViewNegotiationId = null;
  activeLiveViewTeachingSessionId = null;
  liveViewTelemetryAttempts = new Set();
  liveViewSeenNegotiationScope = null;
  liveViewSeenNegotiationIds = new Set();
  wsConnected = false;
  wsTransportConnected = false;
  wsAuthenticatedGeneration = 0;
  wsTransportIdentity = null;
  screenshotPolicyState = Object.freeze({
    mode: 'pending',
    observed: false,
    captureAllowed: false,
    expiresAt: 0,
    scope: null,
    authority: null,
    authorityScope: null,
    captureCadence: backgroundScreenshotCaptureCadence(),
    valid: false,
  });
  screenshotPolicySource = 'pending';
  screenshotPolicyAdoptedAt = 0;
  advanceScreenshotPolicyAuthority();
  screenshotImmediateCapturePending = false;
  protocolPolicyAppliedGeneration = 0;
  screenshotPolicyAppliedGeneration = 0;
  chrome.alarms?.clear?.('screenshot-observation-lease-expiry');
}

function advanceStudentAuthMutationGeneration() {
  abortActiveAuthContext();
  studentAuthMutationGeneration += 1;
  return studentAuthMutationGeneration;
}

function activateAuthenticatedContext(authContextId) {
  const normalizedId = String(authContextId || '').trim();
  if (!normalizedId) {
    const error = new Error('Authenticated context is missing its immutable identifier');
    error.code = 'AUTH_CONTEXT_INCOMPLETE';
    throw error;
  }
  if (
    CONFIG.authContextId === normalizedId
    && activeAuthContextGeneration === studentAuthMutationGeneration
    && !authContextAbortController.signal.aborted
  ) return normalizedId;
  abortActiveAuthContext();
  authContextAbortController = new AbortController();
  activeAuthContextGeneration = studentAuthMutationGeneration;
  CONFIG.authContextId = normalizedId;
  return normalizedId;
}

function authContextSuperseded(reason) {
  const error = new Error(`${reason} belongs to a retired authentication context`);
  error.code = 'AUTH_CONTEXT_SUPERSEDED';
  return error;
}

function captureAuthenticatedContext(reason = 'authenticated operation') {
  if (!hasStudentAuth()) throw authContextSuperseded(reason);
  const serverOrigin = normalizedServerOrigin(CONFIG.serverUrl);
  const authContextId = String(CONFIG.authContextId || '').trim();
  if (
    !authContextId
    || activeAuthContextGeneration !== studentAuthMutationGeneration
    || !serverOrigin
  ) {
    const error = new Error(`${reason} has no complete immutable authentication context`);
    error.code = 'AUTH_CONTEXT_INCOMPLETE';
    throw error;
  }
  return Object.freeze({
    authContextId,
    mutationGeneration: studentAuthMutationGeneration,
    serverOrigin,
    schoolId: String(CONFIG.schoolId || '').trim() || null,
    deviceId: CONFIG.deviceId,
    studentId: CONFIG.activeStudentId,
    studentSessionId: CONFIG.activeStudentSessionId,
    studentToken: CONFIG.studentToken,
    studentEmail: CONFIG.studentEmail || '',
    signal: authContextAbortController.signal,
  });
}

function assertAuthenticatedContextCurrent(context, reason = 'authenticated operation') {
  const commitPendingAllowed = Boolean(
    context?.allowCommitPending === true
    && studentAuthCommitPending
    && studentAuthCommitPendingGeneration === context.mutationGeneration
  );
  if (
    !context
    || context.signal?.aborted
    || context.mutationGeneration !== studentAuthMutationGeneration
    || activeAuthContextGeneration !== studentAuthMutationGeneration
    || context.authContextId !== CONFIG.authContextId
    || context.serverOrigin !== normalizedServerOrigin(CONFIG.serverUrl)
    || context.schoolId !== (String(CONFIG.schoolId || '').trim() || null)
    || context.deviceId !== CONFIG.deviceId
    || context.studentId !== CONFIG.activeStudentId
    || context.studentSessionId !== CONFIG.activeStudentSessionId
    || context.studentToken !== CONFIG.studentToken
    || (!hasStudentAuth() && !commitPendingAllowed)
  ) {
    throw authContextSuperseded(reason);
  }
  return context;
}

function isAuthContextCancellation(error) {
  return error?.code === 'AUTH_CONTEXT_SUPERSEDED'
    || error?.code === 'AUTH_CONTEXT_INCOMPLETE'
    || error?.name === 'AbortError';
}

function assertBindingMatchesAuthContext(
  binding,
  context,
  reason = 'authenticated binding',
  options = {},
) {
  const requireFullAuthority = options.requireFullAuthority === true;
  const expectedControlRevision = currentStudentControlRevision();
  if (
    !binding
    || binding.studentId !== context?.studentId
    || binding.studentSessionId !== context?.studentSessionId
    || (requireFullAuthority && (
      binding.bindingVersion !== 2
      || binding.schoolId !== context?.schoolId
      || binding.deviceId !== context?.deviceId
      || binding.controlRevision === null
      || expectedControlRevision === null
      || binding.controlRevision !== expectedControlRevision
    ))
  ) {
    const error = new Error(`${reason} does not match the immutable authentication context`);
    error.code = 'STUDENT_BINDING_MISMATCH';
    throw error;
  }
  return binding;
}

function authContextProtocolScope(context) {
  return JSON.stringify([
    context?.serverOrigin || '',
    context?.schoolId || '',
    context?.deviceId || '',
    context?.studentId || '',
    context?.studentSessionId || '',
    context?.authContextId || '',
  ]);
}

function adoptNegotiatedProtocolState(raw = {}, context) {
  assertAuthenticatedContextCurrent(context, 'protocol negotiation');
  const serverProtocolVersion = Number(raw.serverProtocolVersion);
  const advertised = new Set(
    Array.isArray(raw.acceptedCapabilities)
      ? raw.acceptedCapabilities.map((value) => String(value || '').trim()).filter(Boolean)
      : [],
  );
  // The accepted list, not the protocol number, is the behavior switch. Keep
  // only capabilities this exact build advertised so a server cannot turn on
  // an unknown or misspelled feature accidentally.
  const scopedAuthorityAccepted = advertised.has('scopedAuthorityChecksV1');
  const acceptedCapabilities = EXTENSION_CAPABILITIES.filter((name) => (
    advertised.has(name)
    && (!SCOPED_AUTHORITY_DEPENDENT_CAPABILITIES.has(name) || scopedAuthorityAccepted)
  ));
  negotiatedProtocolState = Object.freeze({
    scope: authContextProtocolScope(context),
    serverProtocolVersion: Number.isSafeInteger(serverProtocolVersion) && serverProtocolVersion > 0
      ? serverProtocolVersion
      : null,
    acceptedCapabilities: Object.freeze(acceptedCapabilities),
    negotiatedAt: Date.now(),
  });
  return negotiatedProtocolState;
}

function reserveProtocolPolicyRequestGeneration() {
  protocolPolicyRequestGeneration += 1;
  return protocolPolicyRequestGeneration;
}

function reserveScreenshotPolicyRequestGeneration() {
  screenshotPolicyRequestGeneration += 1;
  return screenshotPolicyRequestGeneration;
}

function responseScreenshotLeaseKind(raw = {}) {
  const accepted = new Set(
    Array.isArray(raw?.acceptedCapabilities)
      ? raw.acceptedCapabilities.map((value) => String(value || '').trim()).filter(Boolean)
      : [],
  );
  if (!accepted.has('scopedAuthorityChecksV1')) return null;
  if (accepted.has('screenshotTrackingWindowLeaseV1')) return 'tracking_window';
  if (accepted.has('screenshotObservationLeaseV1')) return 'observation';
  return null;
}

function advanceScreenshotPolicyAuthority() {
  try {
    screenshotPolicyAbortController.abort();
  } catch {
    // The generation fence below remains authoritative if abort delivery fails.
  }
  screenshotPolicyAbortController = new AbortController();
  screenshotPolicyGeneration += 1;
  stopActiveScreenshotCadence('authority-changed');
  return screenshotPolicyGeneration;
}

function canRetainOmittedScreenshotPolicy(context, nowValue = Date.now()) {
  return screenshotPolicyState.scope === screenshotPolicyScope(context)
    && ['lease', 'tracking_window_lease'].includes(screenshotPolicyState.mode)
    && screenshotPolicyState.valid === true
    && Number(screenshotPolicyState.expiresAt || 0) > nowValue;
}

function normalizeScreenshotAuthority(rawAuthority) {
  if (!rawAuthority || typeof rawAuthority !== 'object' || Array.isArray(rawAuthority)) {
    return null;
  }
  const kind = String(rawAuthority.kind || '').trim();
  const controlRevision = Number(rawAuthority.controlRevision);
  if (!Number.isSafeInteger(controlRevision) || controlRevision < 0) return null;
  if (kind === 'student_session') {
    if (String(rawAuthority.teachingSessionId || '').trim()) return null;
    return Object.freeze({ kind, controlRevision });
  }
  if (kind === 'teaching_session') {
    const teachingSessionId = String(rawAuthority.teachingSessionId || '').trim();
    if (!teachingSessionId || teachingSessionId.length > 256) return null;
    return Object.freeze({ kind, teachingSessionId, controlRevision });
  }
  return null;
}

function screenshotAuthorityScope(authority) {
  if (!authority) return null;
  return JSON.stringify([
    authority.kind,
    authority.teachingSessionId || '',
    authority.controlRevision,
  ]);
}

function backgroundScreenshotCaptureCadence() {
  return Object.freeze({
    mode: 'background',
    intervalSeconds: 30,
    expiresAt: 0,
  });
}

function normalizeScreenshotCaptureCadence(rawPolicy, context, options, policy) {
  const background = backgroundScreenshotCaptureCadence();
  if (
    policy?.mode !== 'tracking_window_lease'
    || policy.valid !== true
    || policy.captureAllowed !== true
    || policy.authority?.kind !== 'teaching_session'
    || !hasNegotiatedCapability('screenshotActiveObservationCadenceV1', context)
  ) return background;

  const rawCadence = rawPolicy?.captureCadence;
  if (
    !rawCadence
    || typeof rawCadence !== 'object'
    || Array.isArray(rawCadence)
    || rawCadence.mode !== 'active_view'
    || Number(rawCadence.intervalSeconds) !== 5
  ) return background;

  const expiresInSeconds = Number(rawCadence.expiresInSeconds);
  const serverTime = Date.parse(String(rawPolicy?.serverTime || ''));
  const responseReceivedAt = Number.isFinite(Number(options.responseReceivedAt))
    ? Number(options.responseReceivedAt)
    : Date.now();
  const requestStartedAt = Number.isFinite(Number(options.requestStartedAt))
    ? Number(options.requestStartedAt)
    : responseReceivedAt;
  if (
    !Number.isFinite(expiresInSeconds)
    || expiresInSeconds <= 0
    || expiresInSeconds > 90
    || !Number.isFinite(serverTime)
    || requestStartedAt > responseReceivedAt
    || serverTime < requestStartedAt - 30_000
    || serverTime > responseReceivedAt + 30_000
  ) return background;

  const boundedCadenceMs = expiresInSeconds * 1000;
  const roundTripMs = Math.max(0, responseReceivedAt - requestStartedAt);
  const remainingCadenceMs = Math.max(0, Math.min(
    boundedCadenceMs - roundTripMs,
    serverTime + boundedCadenceMs - responseReceivedAt,
    Number(policy.expiresAt || 0) - responseReceivedAt,
  ));
  if (remainingCadenceMs <= 0) return background;
  return Object.freeze({
    mode: 'active_view',
    intervalSeconds: 5,
    expiresAt: responseReceivedAt + remainingCadenceMs,
  });
}

function activeObservationScreenshotCadenceAllowed(context, nowValue = Date.now()) {
  try {
    assertAuthenticatedContextCurrent(context, 'active observation screenshot cadence');
  } catch {
    return false;
  }
  const cadence = screenshotPolicyState.captureCadence;
  return ambientScreenshotAllowed(context, nowValue)
    && screenshotPolicyState.mode === 'tracking_window_lease'
    && screenshotPolicyState.authority?.kind === 'teaching_session'
    && cadence?.mode === 'active_view'
    && cadence.intervalSeconds === 5
    && Number(cadence.expiresAt || 0) > nowValue;
}

function nextScreenshotCadenceOrder() {
  screenshotCadenceGeneration += 1;
  screenshotCadenceIssuedAt = Math.max(Date.now(), screenshotCadenceIssuedAt + 1);
  return {
    generation: screenshotCadenceGeneration,
    issuedAt: screenshotCadenceIssuedAt,
  };
}

function clearScreenshotNavigationDebounce() {
  if (screenshotNavigationDebounceTimer) clearTimeout(screenshotNavigationDebounceTimer);
  screenshotNavigationDebounceTimer = null;
}

function stopActiveScreenshotCadence(reason = 'inactive') {
  const retiredCadence = activeScreenshotCadence;
  activeScreenshotCadence = null;
  clearScreenshotNavigationDebounce();
  chrome.alarms.clear(SCREENSHOT_ACTIVE_CADENCE_EXPIRY_ALARM);
  const order = nextScreenshotCadenceOrder();
  if (retiredCadence) {
    chrome.runtime.sendMessage({
      type: 'SCREENSHOT_CADENCE_STOP',
      cadenceId: retiredCadence?.cadenceId,
      generation: order.generation,
      issuedAt: order.issuedAt,
      reason,
    }).catch(() => {});
  }
}

function startActiveScreenshotCadence(context) {
  if (!activeObservationScreenshotCadenceAllowed(context)) {
    stopActiveScreenshotCadence('policy-inactive');
    return false;
  }
  const order = nextScreenshotCadenceOrder();
  const cadenceId = globalThis.crypto?.randomUUID?.()
    || `cadence-${order.issuedAt.toString(36)}-${Math.random().toString(36).slice(2)}`;
  const expiresAt = Number(screenshotPolicyState.captureCadence.expiresAt);
  const cadence = Object.freeze({
    cadenceId,
    generation: order.generation,
    issuedAt: order.issuedAt,
    expiresAt,
    authorityScope: screenshotPolicyState.authorityScope,
    authContextId: context.authContextId,
  });
  activeScreenshotCadence = cadence;
  chrome.alarms.create(SCREENSHOT_ACTIVE_CADENCE_EXPIRY_ALARM, { when: expiresAt });
  sendToOffscreen({
    type: 'SCREENSHOT_CADENCE_START',
    cadenceId,
    generation: order.generation,
    issuedAt: order.issuedAt,
    expiresAt,
    intervalMs: SCREENSHOT_ACTIVE_CADENCE_INTERVAL_MS,
  }, {
    assertCurrent: () => {
      assertAuthenticatedContextCurrent(
        context,
        'active observation screenshot cadence scheduling',
      );
      if (
        activeScreenshotCadence !== cadence
        || cadence.authorityScope !== screenshotPolicyState.authorityScope
        || !activeObservationScreenshotCadenceAllowed(context)
      ) throw authContextSuperseded('active observation screenshot cadence scheduling');
    },
  }).catch(() => {});
  return true;
}

function reconcileActiveScreenshotCadence(context) {
  if (activeObservationScreenshotCadenceAllowed(context)) {
    return startActiveScreenshotCadence(context);
  }
  stopActiveScreenshotCadence('background-cadence');
  return false;
}

function expireActiveScreenshotCadence(reason = 'expired', nowValue = Date.now()) {
  if (screenshotPolicyState.captureCadence?.mode !== 'active_view') return false;
  const expiresAt = Number(screenshotPolicyState.captureCadence.expiresAt || 0);
  if (expiresAt > nowValue) {
    chrome.alarms.create(SCREENSHOT_ACTIVE_CADENCE_EXPIRY_ALARM, { when: expiresAt });
    return false;
  }
  screenshotPolicyState = Object.freeze({
    ...screenshotPolicyState,
    captureCadence: backgroundScreenshotCaptureCadence(),
  });
  stopActiveScreenshotCadence(reason);
  scheduleEventHeartbeat('screenshot-active-view-expired');
  return true;
}

function scheduleActiveViewNavigationCapture(reason) {
  let authContext;
  try {
    authContext = captureAuthenticatedContext(`screenshot navigation:${reason}`);
  } catch {
    return false;
  }
  if (!activeObservationScreenshotCadenceAllowed(authContext)) return false;
  const cadence = activeScreenshotCadence;
  if (!cadence) return false;
  clearScreenshotNavigationDebounce();
  screenshotNavigationDebounceTimer = setTimeout(() => {
    screenshotNavigationDebounceTimer = null;
    let currentContext;
    try {
      currentContext = captureAuthenticatedContext(`screenshot navigation:${reason}`);
    } catch {
      return;
    }
    if (
      activeScreenshotCadence !== cadence
      || cadence.authContextId !== currentContext.authContextId
      || cadence.authorityScope !== screenshotPolicyState.authorityScope
      || !activeObservationScreenshotCadenceAllowed(currentContext)
    ) return;
    captureAndSendScreenshot({ reason: 'active-view-navigation' }).catch(() => {});
  }, SCREENSHOT_ACTIVE_NAVIGATION_DEBOUNCE_MS);
  return true;
}

function adoptProtocolAndScreenshotPolicy(raw = {}, context, options = {}) {
  assertAuthenticatedContextCurrent(context, 'protocol and screenshot policy');
  const requestGeneration = Number(options.requestGeneration);
  const generation = Number.isSafeInteger(requestGeneration) && requestGeneration > 0
    ? requestGeneration
    : reserveProtocolPolicyRequestGeneration();
  let protocolApplied = false;
  if (generation >= protocolPolicyAppliedGeneration) {
    protocolPolicyAppliedGeneration = generation;
    adoptNegotiatedProtocolState(raw, context);
    protocolApplied = true;
  }

  const policyPresent = Object.prototype.hasOwnProperty.call(raw, 'screenshotPolicy');
  const leaseKind = responseScreenshotLeaseKind(raw);
  const responseReceivedAt = Number.isFinite(Number(options.responseReceivedAt))
    ? Number(options.responseReceivedAt)
    : Date.now();
  const policyRetentionNow = Math.max(Date.now(), responseReceivedAt);

  if (leaseKind && !policyPresent) {
    // A capable WebSocket auth response may race an older in-flight heartbeat.
    // It carries no screenshot authority, so it must not retire that heartbeat's
    // independently ordered lease. Retain only an exact-scope, unexpired lease;
    // cold, legacy, invalid, expired, or new-scope state remains fail-private.
    if (!canRetainOmittedScreenshotPolicy(context, policyRetentionNow)) {
      adoptScreenshotPolicy(undefined, context, {
        ...options,
        leaseKind,
        policyPresent: false,
      });
    }
    return protocolApplied;
  }

  // A response from a superseded protocol generation may still carry an
  // explicit, independently ordered screenshot policy. Implicit legacy mode,
  // however, is meaningful only when that response's protocol was adopted.
  if (!policyPresent && !protocolApplied) return protocolApplied;

  const rawScreenshotGeneration = Number(options.screenshotRequestGeneration);
  const screenshotGeneration = Number.isSafeInteger(rawScreenshotGeneration)
    && rawScreenshotGeneration > 0
    ? rawScreenshotGeneration
    : reserveScreenshotPolicyRequestGeneration();
  if (screenshotGeneration < screenshotPolicyAppliedGeneration) {
    // Policy responses are independently ordered. A late response for class A
    // must not broaden or revoke the newer class-B authority.
    return protocolApplied;
  } else {
    screenshotPolicyAppliedGeneration = screenshotGeneration;
  }
  adoptScreenshotPolicy(raw?.screenshotPolicy, context, {
    ...options,
    leaseKind,
    policyPresent,
  });
  return true;
}

function hasNegotiatedCapability(name, context = null) {
  let authContext = context;
  try {
    authContext = authContext || captureAuthenticatedContext('capability check');
    assertAuthenticatedContextCurrent(authContext, 'capability check');
  } catch {
    return false;
  }
  return negotiatedProtocolState?.scope === authContextProtocolScope(authContext)
    && negotiatedProtocolState.acceptedCapabilities.includes(name);
}

let restrictionSsoVisitScopeDigest = null;
let visitedRestrictionSsoHosts = new Set();
let restrictionSsoVisitMutation = Promise.resolve();

function enqueueRestrictionSsoVisitMutation(operation) {
  const run = () => operation();
  const next = restrictionSsoVisitMutation.then(run, run);
  // A rejected old-authority writer must not poison cleanup or a later
  // binding's first visit. Keep the caller-visible rejection while allowing
  // the serialized ledger to advance.
  restrictionSsoVisitMutation = next.catch(() => undefined);
  return next;
}

function restrictionSsoPassThroughForState(state = currentClassroomState) {
  return Boolean(
    state?.deliveryContext?.lateSignInRestrictionSso === true
    && (state?.restrictions?.screenLock?.active || state?.restrictions?.flightPath?.active)
  );
}

function normalizedRestrictionSsoHost(urlValue) {
  const host = RuntimeCore.normalizeDomain(urlValue);
  if (!host) return null;
  // Record only the matched allowlisted family, never the arbitrary exact
  // subdomain. This is privacy-minimal and strictly bounds the durable ledger
  // to the two supported roots, so unique tenant/login subdomains cannot grow
  // the set past reconciliation's domain-list limit.
  return RuntimeCore.RESTRICTION_SSO_DOMAINS.find((domain) => (
    RuntimeCore.isHostWithinDomain(host, domain)
  )) || null;
}

async function restrictionSsoBindingDigest(context) {
  assertAuthenticatedContextCurrent(context, 'restriction SSO binding');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof TextEncoder !== 'function') {
    const error = new Error('Secure restriction SSO storage binding is unavailable');
    error.code = 'RESTRICTION_SSO_BINDING_UNAVAILABLE';
    throw error;
  }
  const source = JSON.stringify([
    'restriction-sso-v1',
    context.serverOrigin,
    context.schoolId || '',
    context.studentId,
    context.studentSessionId,
    context.deviceId,
    context.authContextId,
  ]);
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(source));
  assertAuthenticatedContextCurrent(context, 'restriction SSO binding');
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function ensureRestrictionSsoVisitStateForContextNow(context) {
  assertAuthenticatedContextCurrent(context, 'restriction SSO visit restore');
  const scopeDigest = await restrictionSsoBindingDigest(context);
  if (restrictionSsoVisitScopeDigest === scopeDigest) {
    return visitedRestrictionSsoHosts;
  }
  const stored = await rawLocalKv.get([RESTRICTION_SSO_VISIT_STORAGE_KEY]);
  assertAuthenticatedContextCurrent(context, 'restriction SSO visit restore');
  const record = stored[RESTRICTION_SSO_VISIT_STORAGE_KEY];
  const valid = record?.schemaVersion === RESTRICTION_SSO_VISIT_SCHEMA_VERSION
    && record.scopeDigest === scopeDigest
    && Array.isArray(record.visitedHosts);
  const hosts = valid
    ? record.visitedHosts.map(normalizedRestrictionSsoHost).filter(Boolean)
    : [];
  const canonicalHosts = [...new Set(hosts)].sort();
  const requiresCanonicalRewrite = valid
    && JSON.stringify(record.visitedHosts) !== JSON.stringify(canonicalHosts);
  if (requiresCanonicalRewrite) {
    // Provisional builds recorded exact tenant/login subdomains. Rewrite them
    // during restore so the durable privacy/size invariant is complete even
    // when no later navigation adds a new root family. Publish the in-memory
    // scope only after this write succeeds so a transient failure is retryable.
    await rawLocalKv.set({
      [RESTRICTION_SSO_VISIT_STORAGE_KEY]: {
        schemaVersion: RESTRICTION_SSO_VISIT_SCHEMA_VERSION,
        scopeDigest,
        visitedHosts: canonicalHosts,
      },
    });
    assertAuthenticatedContextCurrent(context, 'restriction SSO visit canonicalization');
  }
  if (!valid && record) {
    await rawLocalKv.remove(RESTRICTION_SSO_VISIT_STORAGE_KEY);
    assertAuthenticatedContextCurrent(context, 'restriction SSO visit cleanup');
  }
  restrictionSsoVisitScopeDigest = scopeDigest;
  visitedRestrictionSsoHosts = new Set(canonicalHosts);
  return visitedRestrictionSsoHosts;
}

function ensureRestrictionSsoVisitStateForContext(context) {
  return enqueueRestrictionSsoVisitMutation(() => (
    ensureRestrictionSsoVisitStateForContextNow(context)
  ));
}

function observeRestrictionSsoHostForAuth(urlValue, context) {
  return enqueueRestrictionSsoVisitMutation(async () => {
    assertAuthenticatedContextCurrent(context, 'restriction SSO navigation');
    if (!restrictionSsoPassThroughForState()) return false;
    const host = normalizedRestrictionSsoHost(urlValue);
    if (!host) return false;
    await ensureRestrictionSsoVisitStateForContextNow(context);
    assertAuthenticatedContextCurrent(context, 'restriction SSO navigation');
    if (visitedRestrictionSsoHosts.has(host)) return false;
    // Do not publish the visit to the in-memory ledger until the durable write
    // succeeds. A transient storage failure must leave the host retryable; if
    // memory advanced first, the next navigation would be treated as a no-op
    // and a worker restart would forget that the SSO hop ever happened.
    const nextVisitedHosts = new Set(visitedRestrictionSsoHosts);
    nextVisitedHosts.add(host);
    await rawLocalKv.set({
      [RESTRICTION_SSO_VISIT_STORAGE_KEY]: {
        schemaVersion: RESTRICTION_SSO_VISIT_SCHEMA_VERSION,
        scopeDigest: restrictionSsoVisitScopeDigest,
        visitedHosts: [...nextVisitedHosts].sort(),
      },
    });
    assertAuthenticatedContextCurrent(context, 'restriction SSO navigation persistence');
    visitedRestrictionSsoHosts = nextVisitedHosts;
    return true;
  });
}

function clearRestrictionSsoVisitState() {
  return enqueueRestrictionSsoVisitMutation(async () => {
    restrictionSsoVisitScopeDigest = null;
    visitedRestrictionSsoHosts = new Set();
    await rawLocalKv.remove(RESTRICTION_SSO_VISIT_STORAGE_KEY);
  });
}

function screenshotPolicyScope(context) {
  return authContextProtocolScope(context);
}

function ambientScreenshotAllowed(context, nowValue = Date.now()) {
  try {
    assertAuthenticatedContextCurrent(context, 'screenshot tracking-window lease');
  } catch {
    return false;
  }
  if (screenshotPolicyState.scope !== screenshotPolicyScope(context)) return false;
  if (screenshotPolicyState.mode === 'legacy') return screenshotPolicyState.valid === true;
  if (screenshotPolicyState.mode === 'tracking_window_lease') {
    return screenshotPolicyState.valid === true
      && screenshotPolicyState.captureAllowed === true
      && Boolean(screenshotPolicyState.authorityScope)
      && Number(screenshotPolicyState.expiresAt || 0) > nowValue;
  }
  return screenshotPolicyState.mode === 'lease'
    && screenshotPolicyState.valid === true
    && screenshotPolicyState.observed === true
    && Number(screenshotPolicyState.expiresAt || 0) > nowValue;
}

function assertAmbientScreenshotAllowed(context, reason = 'ambient screenshot') {
  assertAuthenticatedContextCurrent(context, reason);
  if (!ambientScreenshotAllowed(context)) {
    const error = new Error('Screenshot capture is paused while this student is not observed');
    error.code = 'SCREENSHOT_PAUSED_UNOBSERVED';
    throw error;
  }
}

function assertAmbientScreenshotPolicyCurrent(
  context,
  expectedGeneration,
  expectedAuthorityScope,
  reason = 'ambient screenshot',
) {
  assertAuthenticatedContextCurrent(context, reason);
  if (screenshotPolicyGeneration !== expectedGeneration) {
    const error = new Error('Screenshot authority changed during capture');
    error.code = 'SCREENSHOT_POLICY_SUPERSEDED';
    throw error;
  }
  if ((screenshotPolicyState.authorityScope || null) !== (expectedAuthorityScope || null)) {
    const error = new Error('Screenshot authority changed during capture');
    error.code = 'SCREENSHOT_POLICY_SUPERSEDED';
    throw error;
  }
  assertAmbientScreenshotAllowed(context, reason);
}

function requestImmediateScreenshotCapture() {
  if (screenshotCaptureInFlight) {
    screenshotImmediateCapturePending = true;
    return;
  }
  screenshotImmediateCapturePending = false;
  captureAndSendScreenshot({ reason: 'authority-change' }).catch(() => {});
}

function adoptScreenshotPolicy(rawPolicy, context, options = {}) {
  assertAuthenticatedContextCurrent(context, 'screenshot policy');
  const scope = screenshotPolicyScope(context);
  const priorState = screenshotPolicyState;
  const priorAllowed = ambientScreenshotAllowed(context);
  const leaseKind = typeof options.leaseKind === 'string'
    ? options.leaseKind
    : hasNegotiatedCapability('screenshotTrackingWindowLeaseV1', context)
      ? 'tracking_window'
      : hasNegotiatedCapability('screenshotObservationLeaseV1', context)
        ? 'observation'
        : null;
  const policyPresent = typeof options.policyPresent === 'boolean'
    ? options.policyPresent
    : rawPolicy !== undefined;
  let next;
  if (!leaseKind && !policyPresent) {
    // A server that did not accept the capability remains on the v2 ambient
    // behavior. Capability intersection, never a version comparison, chooses
    // this compatibility path.
    next = Object.freeze({
      mode: 'legacy',
      observed: true,
      captureAllowed: true,
      expiresAt: 0,
      scope,
      authority: null,
      authorityScope: null,
      valid: true,
    });
  } else if (rawPolicy?.mode === 'legacy') {
    // Explicit server-side rollback for a capable fleet.
    next = Object.freeze({
      mode: 'legacy',
      observed: true,
      captureAllowed: true,
      expiresAt: 0,
      scope,
      authority: null,
      authorityScope: null,
      valid: true,
    });
  } else {
    const expiresInSeconds = Number(rawPolicy?.expiresInSeconds);
    const serverTime = Date.parse(String(rawPolicy?.serverTime || ''));
    const responseReceivedAt = Number.isFinite(Number(options.responseReceivedAt))
      ? Number(options.responseReceivedAt)
      : Date.now();
    const requestStartedAt = Number.isFinite(Number(options.requestStartedAt))
      ? Number(options.requestStartedAt)
      : responseReceivedAt;
    const maximumLeaseSeconds = leaseKind === 'tracking_window' ? 90 : 120;
    const boundedLeaseMs = Number.isFinite(expiresInSeconds)
      ? Math.min(maximumLeaseSeconds, Math.max(0, expiresInSeconds)) * 1000
      : 0;
    const roundTripMs = Math.max(0, responseReceivedAt - requestStartedAt);
    const serverTimeIsCurrent = Number.isFinite(serverTime)
      && requestStartedAt <= responseReceivedAt
      && serverTime >= requestStartedAt - 30_000
      && serverTime <= responseReceivedAt + 30_000;
    // Subtract the whole request round-trip and also honor the server's
    // absolute lease deadline. Either bound may shorten a lease; neither may
    // extend it after a delayed/replayed response.
    const remainingLeaseMs = serverTimeIsCurrent
      ? Math.max(0, Math.min(
        boundedLeaseMs - roundTripMs,
        serverTime + boundedLeaseMs - responseReceivedAt,
      ))
      : 0;
    const trackingAuthority = leaseKind === 'tracking_window'
      ? normalizeScreenshotAuthority(rawPolicy?.authority)
      : null;
    const validShape = Boolean(leaseKind)
      && (
        (leaseKind === 'tracking_window'
          && rawPolicy?.mode === 'tracking_window_lease'
          && typeof rawPolicy?.captureAllowed === 'boolean'
          && Boolean(trackingAuthority))
        || (leaseKind === 'observation'
          && rawPolicy?.mode === 'lease'
          && typeof rawPolicy?.observed === 'boolean')
      )
      && Number.isFinite(expiresInSeconds)
      && expiresInSeconds >= 0
      && serverTimeIsCurrent;
    const captureAllowed = validShape
      && (leaseKind === 'tracking_window'
        ? rawPolicy.captureAllowed === true
        : rawPolicy.observed === true)
      && expiresInSeconds > 0
      && remainingLeaseMs > 0;
    next = Object.freeze({
      mode: leaseKind === 'tracking_window' ? 'tracking_window_lease' : 'lease',
      observed: leaseKind === 'observation' ? captureAllowed : false,
      captureAllowed: leaseKind === 'tracking_window' ? captureAllowed : false,
      expiresAt: captureAllowed
        ? responseReceivedAt + remainingLeaseMs
        : 0,
      scope,
      authority: trackingAuthority,
      authorityScope: screenshotAuthorityScope(trackingAuthority),
      valid: validShape,
    });
  }
  next = Object.freeze({
    ...next,
    captureCadence: normalizeScreenshotCaptureCadence(rawPolicy, context, options, next),
  });
  screenshotPolicyState = next;
  screenshotPolicySource = typeof options.policySource === 'string'
    ? options.policySource.slice(0, 32)
    : 'unknown';
  screenshotPolicyAdoptedAt = Number.isFinite(Number(options.responseReceivedAt))
    ? Number(options.responseReceivedAt)
    : Date.now();
  const nextAllowed = ambientScreenshotAllowed(context);
  const authorityChanged = priorState.scope !== scope
    || priorState.mode !== next.mode
    || priorState.valid !== next.valid
    || priorState.observed !== next.observed
    || priorState.captureAllowed !== next.captureAllowed
    || priorState.authorityScope !== next.authorityScope
    || priorAllowed !== nextAllowed;
  if (authorityChanged) advanceScreenshotPolicyAuthority();
  if (!nextAllowed) screenshotImmediateCapturePending = false;
  chrome.alarms.clear(SCREENSHOT_LEASE_EXPIRY_ALARM);
  if (['lease', 'tracking_window_lease'].includes(next.mode) && nextAllowed) {
    chrome.alarms.create(SCREENSHOT_LEASE_EXPIRY_ALARM, { when: next.expiresAt });
  }
  scheduleScreenshotCapture(nextAllowed);
  reconcileActiveScreenshotCadence(context);
  if (authorityChanged && nextAllowed) {
    requestImmediateScreenshotCapture();
  }
  return next;
}

function applyServerScreenshotPolicyDenial(rawPolicy, context, options = {}) {
  assertAuthenticatedContextCurrent(context, 'server screenshot policy denial');
  const capturedAuthorityScope = options.capturedAuthorityScope || null;
  const currentAuthorityScope = screenshotPolicyState.authorityScope || null;
  const responseAuthority = normalizeScreenshotAuthority(rawPolicy?.authority);
  const responseAuthorityScope = screenshotAuthorityScope(responseAuthority);
  if (
    screenshotPolicyState.mode === 'tracking_window_lease'
    && capturedAuthorityScope !== currentAuthorityScope
    && (!responseAuthorityScope || responseAuthorityScope === capturedAuthorityScope)
  ) {
    // This upload was fenced to a retired authority. A denial that carries no
    // replacement policy (or repeats retired A) cannot revoke current B.
    return screenshotPolicyState;
  }
  const denialGeneration = reserveScreenshotPolicyRequestGeneration();
  screenshotPolicyAppliedGeneration = denialGeneration;
  return adoptScreenshotPolicy(rawPolicy, context, {
    ...options,
    policySource: 'upload_denial',
    leaseKind: hasNegotiatedCapability('screenshotTrackingWindowLeaseV1', context)
      ? 'tracking_window'
      : 'observation',
    policyPresent: true,
  });
}

function applySuccessfulScreenshotUploadPolicy(rawPolicy, context, options = {}) {
  assertAuthenticatedContextCurrent(context, 'successful screenshot upload policy');
  if (!rawPolicy || typeof rawPolicy !== 'object') return screenshotPolicyState;
  const capturedAuthorityScope = options.capturedAuthorityScope || null;
  if (
    screenshotPolicyState.mode !== 'tracking_window_lease'
    || capturedAuthorityScope !== (screenshotPolicyState.authorityScope || null)
  ) return screenshotPolicyState;
  const requestGeneration = Number(options.screenshotRequestGeneration);
  if (!Number.isSafeInteger(requestGeneration) || requestGeneration < screenshotPolicyAppliedGeneration) {
    return screenshotPolicyState;
  }
  screenshotPolicyAppliedGeneration = requestGeneration;
  return adoptScreenshotPolicy(rawPolicy, context, {
    ...options,
    policySource: 'upload_success',
    leaseKind: 'tracking_window',
    policyPresent: true,
  });
}

function buildDeviceAuthHeaders(context = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (context) assertAuthenticatedContextCurrent(context, 'device authentication headers');
  const studentToken = context?.studentToken || CONFIG.studentToken;
  if (studentToken) {
    headers.Authorization = `Bearer ${studentToken}`;
  }
  return headers;
}

function attachLegacyStudentToken(payload, headers, context = null) {
  if (context) assertAuthenticatedContextCurrent(context, 'legacy student authentication');
  const studentToken = context?.studentToken || CONFIG.studentToken;
  if (studentToken && !headers.Authorization) {
    payload.studentToken = studentToken;
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
  const policyGeneration = advanceManagedAuthGatePolicyGeneration();
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
    const nextPersistedDescriptor = persistedManagedAuthGateDescriptor(descriptor);
    const preservedCanonicalSchoolId = canonicalSchoolIdForUnchangedSlugPolicy(
      descriptor,
      stored[MANAGED_AUTH_GATE_BINDING_KEY],
      stored.config || CONFIG,
    );
    const nextBindingKey = authGateConfigBindingKey({
      serverOrigin: descriptor.serverManaged && descriptor.serverValid
        ? descriptor.serverOrigin
        : normalizedServerOrigin(DEFAULT_SERVER_URL),
      schoolId: descriptor.schoolId || preservedCanonicalSchoolId,
      schoolSlug: descriptor.schoolSlug,
    });
    const authorityChanged = priorBindingKey !== nextBindingKey
      || priorEnrollmentKey !== descriptor.enrollmentKey;
    const managedPolicyChanged = authorityChanged
      || !managedAuthGatePolicyDescriptorsMatch(
        stored[MANAGED_AUTH_GATE_BINDING_KEY],
        nextPersistedDescriptor,
      );
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

    if (managedPolicyChanged) {
      // A signed-out profile can still contain a crash-surviving SSO visit
      // ledger. Every effective managed-policy transition clears it even when
      // there is no bearer material that would otherwise enter
      // clearStudentAuth(). This includes a fast-auth kill-switch change that
      // leaves the school/server authority tuple unchanged.
      await clearRestrictionSsoVisitState();
      assertManagedPolicyRevalidationCurrent(
        policyGeneration,
        policyBarrier,
        'managed policy restriction SSO cleanup',
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
      authoritativeManagedSchoolPolicyScope = null;
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
  scheduleAuthGateRosterContextReconcile().catch(() => {});
  bumpAuthGateStateRevision();
  return sharedSignInLoginConfig;
}

function sanitizedAuthGateTimingLabel(value, fallback) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return normalized || fallback;
}

function boundedAuthGateTimingDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration)
    ? Math.max(0, Math.min(10 * 60 * 1000, Math.round(duration)))
    : null;
}

async function persistContentAuthGateTiming(rawTiming) {
  const timing = rawTiming && typeof rawTiming === 'object' && !Array.isArray(rawTiming)
    ? rawTiming
    : {};
  const record = {
    loadingPaintMs: boundedAuthGateTimingDuration(timing.loadingPaintMs),
    configReadyMs: boundedAuthGateTimingDuration(timing.configReadyMs),
    outcome: sanitizedAuthGateTimingLabel(timing.outcome, 'unknown'),
    coldWorker: timing.coldWorker === true,
    timestamp: Date.now(),
  };
  await kv.set({ [AUTH_GATE_TIMING_STORAGE_KEY]: record });
  return true;
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
      console.warn('[Auth Gate] Shared sign-in config unavailable:', safeDiagnosticError(error));
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
      console.warn('[Auth Gate] Shared sign-in config check failed:', safeDiagnosticError(error));
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
    rosterContextGeneration: currentAuthGateRosterContextGeneration(),
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

function getPublishablePopupConfig() {
  return {
    schoolId: CONFIG.schoolId || null,
    studentName: CONFIG.studentName || null,
    studentEmail: CONFIG.studentEmail || null,
    classId: CONFIG.classId || null,
    hasStudentToken: Boolean(CONFIG.studentToken),
  };
}

async function getPublishableAuthGateState() {
  await awaitAuthGateRevisionPublicationReady();
  while (true) {
    await awaitAuthGateRosterContextStable();
    const state = getAuthGateState();
    await Promise.all([
      awaitAuthGateRevisionPublicationReady(),
      awaitAuthGateRosterContextStable(),
    ]);
    if (
      authGateStatePendingRevisionBumps === 0
      && state.revision === authGateStateRevision
      && state.rosterContextGeneration === currentAuthGateRosterContextGeneration()
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
    console.warn('[Auth Gate] Failed to notify tabs:', safeDiagnosticError(error));
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
    const policyGeneration = advanceManagedAuthGatePolicyGeneration();
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
    // The visit ledger is scoped to both the immutable student binding and
    // the managed policy under which that binding was used. Serialize a clear
    // for every managed-policy storage transition, including a
    // fastAuthGateEnabled-only change that deliberately keeps bearer auth.
    const restrictionSsoPolicyClearPromise = clearRestrictionSsoVisitState();
    restrictionSsoPolicyClearPromise.catch(() => {});

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
      restrictionSsoPolicyClearPromise,
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
        authoritativeManagedSchoolPolicyScope = null;
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
    // safe across a subsequent MV3 restart. The authoritative clear path is
    // the sole exception because it owns the fail-closed fence and must finish
    // before the startup recovery barrier can resolve.
    if (options.skipAuthRestoreWait !== true) {
      await authStateRestorePromise;
    }
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
  const manualAuthSessionStorageUnavailable = isManualIdentitySource(stored?.identitySource)
    && !hasSessionStorage();
  const authRestoreBlocked = interruptedAuthClear
    || interruptedAuthCommit
    || manualAuthTimestampInvalid
    || manualAuthSessionStorageUnavailable;
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
      if (stored?.authContextId) CONFIG.authContextId = String(stored.authContextId).trim() || null;
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
      if (!CONFIG.authContextId) {
        CONFIG.authContextId = generateAuthContextId();
        await setManualAuthState({ authContextId: CONFIG.authContextId });
        assertCurrent();
      }
      studentAuthInvalidating = false;
      activateAuthenticatedContext(CONFIG.authContextId);
      const restoredAuthContext = captureAuthenticatedContext('worker wake storage adoption');
      await cleanupRetiredExactBoundStorage(
        restoredAuthContext,
        'worker wake storage adoption',
      );
      assertCurrent();
      if (trackingState !== TRACKING_STATES.OFF) connectWebSocket().catch(() => {});
    }
    return {
      interruptedAuthClear,
      interruptedAuthCommit,
      manualAuthTimestampInvalid,
      manualAuthSessionStorageUnavailable,
    };
  });
}

function clearStudentAuth(reason = 'manual-clear', options = {}) {
  if (options.expectedAuthContext) {
    assertAuthenticatedContextCurrent(options.expectedAuthContext, `authentication clear:${reason}`);
  }
  const signOutAuthority = Object.freeze({
    token: options.expectedAuthContext?.studentToken || CONFIG.studentToken || null,
    serverOrigin: options.expectedAuthContext?.serverOrigin
      || normalizedServerOrigin(CONFIG.serverUrl),
    deviceId: options.expectedAuthContext?.deviceId || CONFIG.deviceId || null,
    authContextId: options.expectedAuthContext?.authContextId || CONFIG.authContextId || null,
  });
  const clearOptions = { ...options, signOutAuthority };
  // Reserve the mutation and revoke the current authority synchronously. A
  // login already waiting on the network must not briefly reinstall its old
  // response before this cleanup reaches the queue.
  advanceStudentAuthMutationGeneration();
  studentAuthInvalidating = true;
  if (fastAuthGateEnabled) {
    resetSharedSignInLoginConfigCache({ clearPersisted: true });
  }
  if (options.disconnectWebSocket !== false) disconnectWebSocket();
  const invalidationPersisted = durableLocalKv.set({ [STUDENT_AUTH_INVALIDATING_KEY]: true });
  return enqueueStudentAuthMutation(() => clearStudentAuthNow(
    reason,
    clearOptions,
    invalidationPersisted,
  ));
}

async function notifyBackendOfStudentSignOut(signOutAuthority, reason) {
  if (
    !signOutAuthority?.token
    || !signOutAuthority.serverOrigin
    || !signOutAuthority.deviceId
  ) return false;
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, SIGN_OUT_REQUEST_TIMEOUT_MS);
  });
  const request = Promise.resolve().then(() => fetchWithBackoff(
    `${signOutAuthority.serverOrigin}/api/extension/sign-out`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signOutAuthority.token}`,
      },
      body: JSON.stringify({ deviceId: signOutAuthority.deviceId, reason }),
      signal: controller.signal,
    },
    {
      context: 'student sign-out',
      maxAttempts: 1,
      respectGlobalBackoff: false,
    },
  )).then(
    (response) => ({ completed: response?.ok === true, status: Number(response?.status || 0) }),
    (error) => ({ error }),
  );
  const outcome = await Promise.race([request, timeout]);
  clearTimeout(timeoutId);
  if (outcome?.timedOut) {
    console.warn('[Auth] Session-end call timed out');
  } else if (outcome?.error && !isAuthContextCancellation(outcome.error)) {
    console.warn('[Auth] Session-end call failed:', safeDiagnosticError(outcome.error));
  } else if (outcome?.completed !== true) {
    console.warn('[Auth] Session-end call was not accepted');
  }
  return outcome?.completed === true;
}

async function clearStudentAuthNow(reason = 'manual-clear', options = {}, invalidationPersisted) {
  await invalidationPersisted;
  const signOutAuthority = options.signOutAuthority || {};
  const tokenToEnd = signOutAuthority.token || null;
  const pauseAutoRegistration = options.pauseAutoRegistration === true;
  const disconnect = options.disconnectWebSocket !== false;
  // Revoke the in-memory authority before the first await. Cleanup and the
  // captured-token flush may take time; old exact-bound frames must fail
  // closed throughout that window.
  studentAuthInvalidating = true;
  sharedAuthLockedSinceAt = 0;
  chrome.alarms.clear(SHARED_AUTH_LOCK_ALARM_NAME);

  // Recovery authority is durable before the reusable bearer and exact
  // student binding are removed. A delayed clear is scoped to its original
  // authContextId, so it cannot queue or release a newer login.
  const recoveryTransition = await transitionStudentSessionRecoveryForAuthClear(
    signOutAuthority.authContextId,
    {
      serverSessionEnded: options.serverSessionEnded === true,
      preserveForGate: options.preserveRecoveryForGate === true,
    },
  );

  // A confirmed student sign-out/profile change ends the student-bound
  // classroom context. Clear only teacher-session ranges; school policy stays.
  await clearTeacherSessionStateForSignOut().catch((error) => {
    console.warn('[Auth] Classroom state clear failed:', safeDiagnosticError(error));
  });
  await clearFabAndOverlayState(reason, { closeChat: true }).catch((error) => {
    console.warn('[Auth] FAB/overlay state clear failed:', safeDiagnosticError(error));
  });
  await clearStudentMessageState(reason).catch((error) => {
    console.warn('[Auth] Student message state clear failed:', safeDiagnosticError(error));
  });
  // Local logout never waits for old HTTP work. Once recovery authority and
  // the invalidation fence are durable, discard exact-bound outboxes instead
  // of trying to transmit them under a retiring bearer. Retrying any of this
  // state under a later student would be both misleading and unsafe.
  await discardMonitoringEventOutbox().catch(() => {});
  await discardCommandAckOutbox().catch(() => {});
  await discardChatAckOutbox().catch(() => {});
  // Outbound student messages are exact-bound and may never cross a student,
  // school, session, device, or server transition. Do not attempt an old
  // message under a later credential.
  await discardStudentChatOutbox().catch(() => {});
  await clearRestrictionSsoVisitState().catch(() => {});
  await kv.remove(TAB_SNAPSHOT_STORAGE_KEY);
  await kv.remove(PENDING_CHECK_IN_KEY);
  await chrome.alarms.clear(PENDING_CHECK_IN_EXPIRY_ALARM);
  currentTabSnapshotRevision = 0;
  lastKnownTabs = [];
  lastKnownTabsAuthBinding = null;

  // 2.6.8: the pause fence is MONOTONIC across clears — a later clear (e.g.
  // a second sign-out tap after identity was already nulled) must never lower
  // a pause an earlier clear raised, or the next worker wake auto-registers
  // the student straight back in. Only a deliberate credentialed login (or a
  // chrome-profile email CHANGE, which clears the stored pause explicitly)
  // re-enables auto-registration.
  const nextAutoRegistrationPaused =
    pauseAutoRegistration || CONFIG.autoRegistrationPaused === true;

  CONFIG.studentToken = null;
  CONFIG.authContextId = null;
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
  // Local invalidation is durable before the optional server notification.
  // Most lifecycle clears stay fire-and-forget so old network work cannot
  // hold the auth queue. A deliberate student sign-out is different: the
  // gate must not fetch its first roster until the exact server session has
  // ended, otherwise a cold Chromebook can hide that student for the full
  // five-minute lease before managed-device continuity has been established.
  // The request itself is bounded by SIGN_OUT_REQUEST_TIMEOUT_MS.
  const shouldNotifyBackend = options.notifyBackend
    && tokenToEnd
    && (
      options.awaitBackendSignOut === true
      || !recoveryTransition.handledExactRecovery
    );
  if (shouldNotifyBackend) {
    const backendSignOut = notifyBackendOfStudentSignOut(signOutAuthority, reason);
    if (options.awaitBackendSignOut === true) {
      const backendSignOutConfirmed = await backendSignOut;
      if (backendSignOutConfirmed && recoveryTransition.handledExactRecovery) {
        // The exact bearer endpoint commits before it replies. Remove the now
        // obsolete local recovery capability so a later cleanup cannot race a
        // replacement login or present a stale Resume grant.
        await transitionStudentSessionRecoveryForAuthClear(
          signOutAuthority.authContextId,
          { serverSessionEnded: true },
        );
      }
    } else {
      backendSignOut.catch(() => {});
    }
  }
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
  scheduleHealthCheckAlarm(5);
  scheduleScreenshotCapture(false);
  chrome.alarms.clear(CONNECTIVITY_HEALTH_ALARM_NAME);
  if (disconnect) {
    await disconnectWebSocket();
  }
  await setConnectivityBadge(connectivityStatus());
  if (options.notifyAuthGateTabs !== false) {
    await notifyAuthGateStateToTabs({
      triggerRefresh: false,
      // This clear is itself the authoritative fail-closed transition. Startup
      // crash recovery intentionally keeps authStateRestorePromise pending
      // until this durable clear completes, so tab notification must not wait
      // on the promise that it is responsible for allowing to resolve.
      skipAuthRestoreWait: true,
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

function sharedAuthLockOwnerFor(authContext, lockedSince) {
  return {
    schemaVersion: 1,
    authContextId: authContext.authContextId,
    binding: monitoringEventAuthBindingForContext(authContext),
    lockedSince: Number(lockedSince || 0),
  };
}

function sharedAuthLockOwnerMatches(owner, authContext) {
  return Boolean(
    owner
    && authContext
    && owner.schemaVersion === 1
    && String(owner.authContextId || '') === authContext.authContextId
    && String(owner.binding || '') === monitoringEventAuthBindingForContext(authContext)
    && Number(owner.lockedSince || 0) > 0
  );
}

async function persistSharedAuthLockState(values, _useManualStorage) {
  // Lock ownership includes the exact authenticated binding, so it follows
  // the same browser-session-only storage rule as the student credentials.
  await setManualAuthState(values);
}

function clearSharedAuthLockTimer(options = {}) {
  let authContext = options.authContext || null;
  if (!authContext && hasStudentAuth()) {
    try {
      authContext = captureAuthenticatedContext('shared auth lock clear');
    } catch {
      authContext = null;
    }
  }
  const mutationGeneration = options.authMutationGeneration ?? studentAuthMutationGeneration;
  return enqueueStudentAuthMutation(async () => {
    if (authContext) {
      assertAuthenticatedContextCurrent(authContext, 'shared auth lock clear');
    } else {
      assertAuthMutationCurrent(mutationGeneration, 'shared auth lock clear');
    }
    const stored = await getStoredAuthState([
      'sharedAuthLockedSinceAt',
      SHARED_AUTH_LOCK_OWNER_KEY,
    ]);
    if (authContext) {
      assertAuthenticatedContextCurrent(authContext, 'shared auth lock clear');
      const storedOwner = stored[SHARED_AUTH_LOCK_OWNER_KEY];
      if (storedOwner && !sharedAuthLockOwnerMatches(storedOwner, authContext)) return false;
    } else {
      assertAuthMutationCurrent(mutationGeneration, 'shared auth lock clear');
    }
    sharedAuthLockedSinceAt = 0;
    await chrome.alarms.clear(SHARED_AUTH_LOCK_ALARM_NAME);
    if (authContext) assertAuthenticatedContextCurrent(authContext, 'shared auth lock clear');
    await persistSharedAuthLockState({
      sharedAuthLockedSinceAt: null,
      [SHARED_AUTH_LOCK_OWNER_KEY]: null,
    }, Boolean(authContext && isManualIdentitySource()));
    if (authContext) assertAuthenticatedContextCurrent(authContext, 'shared auth lock clear');
    return true;
  });
}

function scheduleSharedAuthLockTimer(reason = 'locked') {
  let authContext;
  try {
    authContext = captureAuthenticatedContext('shared auth lock schedule');
  } catch {
    return clearSharedAuthLockTimer({ authMutationGeneration: studentAuthMutationGeneration });
  }
  return enqueueStudentAuthMutation(async () => {
    assertAuthenticatedContextCurrent(authContext, 'shared auth lock schedule');
    if (!isManualIdentitySource()) return false;
    const stored = await getStoredAuthState([
      'sharedAuthLockedSinceAt',
      SHARED_AUTH_LOCK_OWNER_KEY,
    ]);
    assertAuthenticatedContextCurrent(authContext, 'shared auth lock schedule');
    const storedOwner = stored[SHARED_AUTH_LOCK_OWNER_KEY];
    const lockedSince = sharedAuthLockOwnerMatches(storedOwner, authContext)
      ? Number(storedOwner.lockedSince)
      : Date.now();
    const owner = sharedAuthLockOwnerFor(authContext, lockedSince);
    await persistSharedAuthLockState({
      sharedAuthLockedSinceAt: lockedSince,
      [SHARED_AUTH_LOCK_OWNER_KEY]: owner,
    }, true);
    assertAuthenticatedContextCurrent(authContext, 'shared auth lock schedule');
    sharedAuthLockedSinceAt = lockedSince;
    chrome.alarms.create(SHARED_AUTH_LOCK_ALARM_NAME, {
      when: lockedSince + SHARED_AUTH_LOCK_TIMEOUT_MS,
    });
    console.log(`[Auth] Shared-device lock timeout scheduled (${reason})`);
    return true;
  });
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
  let authContext;
  try {
    authContext = captureAuthenticatedContext('shared auth lock timeout');
  } catch {
    await clearSharedAuthLockTimer({ authMutationGeneration: studentAuthMutationGeneration });
    return;
  }
  const decision = await enqueueStudentAuthMutation(async () => {
    assertAuthenticatedContextCurrent(authContext, 'shared auth lock timeout');
    if (!isManualIdentitySource()) return { clear: false };
    const currentState = await new Promise(resolve => {
      if (!chrome.idle?.queryState) {
        resolve(idleState);
        return;
      }
      chrome.idle.queryState(IDLE_DETECTION_SECONDS, resolve);
    });
    assertAuthenticatedContextCurrent(authContext, 'shared auth lock timeout');
    idleState = currentState || idleState;
    const stored = await getStoredAuthState([
      'sharedAuthLockedSinceAt',
      SHARED_AUTH_LOCK_OWNER_KEY,
    ]);
    assertAuthenticatedContextCurrent(authContext, 'shared auth lock timeout');
    const owner = stored[SHARED_AUTH_LOCK_OWNER_KEY];
    if (!sharedAuthLockOwnerMatches(owner, authContext)) return { clear: false };
    if (idleState !== 'locked') return { clear: true, expired: false };
    const expiresAt = Number(owner.lockedSince) + SHARED_AUTH_LOCK_TIMEOUT_MS;
    if (Date.now() < expiresAt) {
      chrome.alarms.create(SHARED_AUTH_LOCK_ALARM_NAME, { when: expiresAt });
      return { clear: false };
    }
    return { clear: false, expired: true };
  });
  if (decision.clear) {
    await clearSharedAuthLockTimer({ authContext });
    await updateTrackingState('lock-timeout-cancelled');
    return;
  }
  if (!decision.expired) return;
  assertAuthenticatedContextCurrent(authContext, 'shared auth lock timeout');
  console.log('[Auth] Shared-device student auth cleared after lock timeout');
  await clearStudentAuth('auto_locked_timeout', {
    notifyBackend: true,
    pauseAutoRegistration: true,
    expectedAuthContext: authContext,
  });
}

function loginRosterRefreshAfterMs() {
  return randomIntBetween(LOGIN_ROSTER_REFRESH_MIN_MS, LOGIN_ROSTER_REFRESH_MAX_MS);
}

function normalizeLoginRosterStudents(students) {
  return (Array.isArray(students) ? students : []).flatMap((student) => {
    if (!student || typeof student !== 'object' || Array.isArray(student)) return [];
    const id = String(student.id || '').trim();
    if (!id || id.length > 128) return [];
    const name = String(student.name || '').trim().slice(0, 256) || 'Student';
    const gradeLevel = student.gradeLevel === undefined || student.gradeLevel === null
      ? null
      : String(student.gradeLevel).trim().slice(0, 64);
    return [{
      id,
      name,
      gradeLevel,
      hasPin: student.hasPin === true,
      reclaimable: student.reclaimable === true,
    }];
  });
}

function normalizeLoginRosterGrades(grades) {
  return (Array.isArray(grades) ? grades : []).flatMap((grade) => {
    if (!grade || typeof grade !== 'object' || Array.isArray(grade)) return [];
    const value = String(grade.value || '').trim().slice(0, 64);
    if (!value) return [];
    return [{
      value,
      label: String(grade.label || value).trim().slice(0, 128) || value,
    }];
  });
}

function loginRosterRequestCacheKey(gradeLevel, recoveryRecord, continuityRecord) {
  const binding = authGateConfigBinding();
  return JSON.stringify([
    binding.serverOrigin || '',
    binding.schoolId || '',
    binding.schoolSlug || '',
    managedAuthGatePolicyGeneration,
    sharedSignInConfigGeneration,
    String(gradeLevel || ''),
    recoveryRecord?.generation || continuityRecord?.generation || '',
  ]);
}

function recordLoginRosterBackoff(cacheKey, delayMs) {
  const parsedDelay = Number(delayMs);
  if (!Number.isFinite(parsedDelay) || parsedDelay <= 0) return 0;
  const boundedDelay = Math.min(LOGIN_ROSTER_BACKOFF_MAX_MS, Math.max(1, parsedDelay));
  const notBefore = Date.now() + boundedDelay;
  loginRosterBackoffUntil.set(cacheKey, notBefore);
  while (loginRosterBackoffUntil.size > 12) {
    loginRosterBackoffUntil.delete(loginRosterBackoffUntil.keys().next().value);
  }
  return boundedDelay;
}

function loginRosterBackoffRemainingMs(cacheKey) {
  const notBefore = Number(loginRosterBackoffUntil.get(cacheKey) || 0);
  if (!Number.isFinite(notBefore) || notBefore <= Date.now()) {
    loginRosterBackoffUntil.delete(cacheKey);
    return 0;
  }
  return Math.max(1, notBefore - Date.now());
}

async function fetchLoginRosterForGate(options = {}) {
  await studentAuthMutationTail;
  const legacySessionEnded = await dispatchLegacyStudentAuthCleanup();
  if (!legacySessionEnded) {
    return {
      success: false,
      setupRequired: false,
      unavailable: true,
      phase: 'unavailable',
      refreshAfterMs: 5000,
      error: 'ClassPilot is finishing the previous student sign-out. Try again in a moment.',
    };
  }
  const recoveryRecord = await prepareStudentSessionRecoveryForGate();
  const continuityRecord = await requestManagedDeviceContinuityProof({ recoveryRecord });
  const directRecoveryRecord = continuityRecord ? null : recoveryRecord;
  const requestedGradeLevel = String(options.gradeLevel || '').trim();
  const cacheKey = loginRosterRequestCacheKey(
    requestedGradeLevel,
    directRecoveryRecord,
    continuityRecord,
  );
  const cached = loginRosterCache.get(cacheKey);
  const backoffRemainingMs = loginRosterBackoffRemainingMs(cacheKey);
  if (backoffRemainingMs > 0) {
    if (cached) {
      const recoveryGrantId = bindLoginRosterAuthorizationGrant(
        directRecoveryRecord,
        continuityRecord,
        cached.data.students,
        cacheKey,
      );
      return {
        ...cached.data,
        ...(recoveryGrantId ? { recoveryGrantId } : {}),
        cached: true,
        warning: true,
        refreshAfterMs: backoffRemainingMs,
      };
    }
    clearLoginRosterRecoveryGrant(cacheKey);
    return {
      success: false,
      setupRequired: false,
      unavailable: true,
      phase: 'unavailable',
      refreshAfterMs: backoffRemainingMs,
      error: 'ClassPilot is temporarily unavailable',
    };
  }
  if (
    options.forceRefresh !== true
    && cached
    && Date.now() - cached.fetchedAt < LOGIN_ROSTER_CACHE_MIN_AGE_MS
  ) {
    const recoveryGrantId = bindLoginRosterAuthorizationGrant(
      directRecoveryRecord,
      continuityRecord,
      cached.data.students,
      cacheKey,
    );
    return {
      ...cached.data,
      ...(recoveryGrantId ? { recoveryGrantId } : {}),
      cached: true,
    };
  }
  const existing = loginRosterInFlight.get(cacheKey);
  if (existing) return existing;
  const request = fetchLoginRosterNetworkForGate({
    ...options,
    gradeLevel: requestedGradeLevel,
    recoveryRecord: directRecoveryRecord,
    continuityRecord,
  }).then(async (result) => {
    if (result?.continuityFallbackRequired === true && continuityRecord) {
      await clearManagedDeviceContinuityState(continuityRecord.generation);
      const currentRecovery = matchingStudentSessionRecoveryRecord();
      const fallbackRecoveryRecord = recoveryRecord
        && currentRecovery?.generation === recoveryRecord.generation
        && currentRecovery.token === recoveryRecord.token
        ? currentRecovery
        : null;
      const fallbackResult = await fetchLoginRosterNetworkForGate({
        ...options,
        gradeLevel: requestedGradeLevel,
        recoveryRecord: fallbackRecoveryRecord,
        continuityRecord: null,
        continuityFallbackAttempted: true,
      });
      if (!fallbackResult?.success) return fallbackResult;
      const fallbackCacheKey = loginRosterRequestCacheKey(
        requestedGradeLevel,
        fallbackRecoveryRecord,
        null,
      );
      const fallbackData = {
        ...fallbackResult,
        cached: false,
        refreshAfterMs: Number(fallbackResult.refreshAfterMs) || loginRosterRefreshAfterMs(),
      };
      loginRosterCache.set(fallbackCacheKey, { data: fallbackData, fetchedAt: Date.now() });
      const recoveryGrantId = bindLoginRosterAuthorizationGrant(
        fallbackRecoveryRecord,
        null,
        fallbackData.students,
        fallbackCacheKey,
      );
      return {
        ...fallbackData,
        ...(recoveryGrantId ? { recoveryGrantId } : {}),
      };
    }
    if (result?.success) {
      loginRosterBackoffUntil.delete(cacheKey);
      const data = {
        ...result,
        cached: false,
        refreshAfterMs: Number(result.refreshAfterMs) || loginRosterRefreshAfterMs(),
      };
      loginRosterCache.set(cacheKey, { data, fetchedAt: Date.now() });
      while (loginRosterCache.size > 12) {
        loginRosterCache.delete(loginRosterCache.keys().next().value);
      }
      const recoveryGrantId = bindLoginRosterAuthorizationGrant(
        directRecoveryRecord,
        continuityRecord,
        data.students,
        cacheKey,
      );
      return {
        ...data,
        ...(recoveryGrantId ? { recoveryGrantId } : {}),
      };
    }
    if (result?.unavailable === true) {
      result.refreshAfterMs = recordLoginRosterBackoff(
        cacheKey,
        Number(result.refreshAfterMs) || loginRosterRefreshAfterMs(),
      );
    } else {
      loginRosterBackoffUntil.delete(cacheKey);
    }
    if (cached && result?.unavailable === true) {
      const recoveryGrantId = bindLoginRosterAuthorizationGrant(
        directRecoveryRecord,
        continuityRecord,
        cached.data.students,
        cacheKey,
      );
      return {
        ...cached.data,
        ...(recoveryGrantId ? { recoveryGrantId } : {}),
        cached: true,
        warning: true,
        refreshAfterMs: Number(result.refreshAfterMs) || loginRosterRefreshAfterMs(),
      };
    }
    clearLoginRosterRecoveryGrant(cacheKey);
    return result;
  }).catch((error) => {
    const refreshAfterMs = recordLoginRosterBackoff(cacheKey, loginRosterRefreshAfterMs());
    if (cached) {
      const recoveryGrantId = bindLoginRosterAuthorizationGrant(
        directRecoveryRecord,
        continuityRecord,
        cached.data.students,
        cacheKey,
      );
      return {
        ...cached.data,
        ...(recoveryGrantId ? { recoveryGrantId } : {}),
        cached: true,
        warning: true,
        refreshAfterMs,
      };
    }
    throw error;
  }).finally(() => {
    if (loginRosterInFlight.get(cacheKey) === request) loginRosterInFlight.delete(cacheKey);
  });
  loginRosterInFlight.set(cacheKey, request);
  return request;
}

async function fetchLoginRosterNetworkForGate(options = {}) {
  const useFastAuthGate = fastAuthGateEnabled;
  const requestAuthMutationGeneration = studentAuthMutationGeneration;
  const requestConfigGeneration = sharedSignInConfigGeneration;
  const requestPolicyGeneration = managedAuthGatePolicyGeneration;
  const requestRecoveryGeneration = options.recoveryRecord?.generation || null;
  const requestContinuityGeneration = options.continuityRecord?.generation || null;
  const requestBindingKey = authGateConfigBindingKey();
  const requestIsStale = () => (
    requestAuthMutationGeneration !== studentAuthMutationGeneration
    || requestConfigGeneration !== sharedSignInConfigGeneration
    || requestPolicyGeneration !== managedAuthGatePolicyGeneration
    || requestBindingKey !== authGateConfigBindingKey()
    || (requestRecoveryGeneration
      ? ![studentSessionRecoveryState.armed, ...studentSessionRecoveryState.pending]
        .some((record) => record?.generation === requestRecoveryGeneration)
      : (!requestContinuityGeneration && Boolean(matchingStudentSessionRecoveryRecord())))
    || (requestContinuityGeneration
      ? currentManagedDeviceContinuityProof()?.generation !== requestContinuityGeneration
      : (!requestRecoveryGeneration && Boolean(currentManagedDeviceContinuityProof())))
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
  const requestHeaders = {
    'X-ClassPilot-Enrollment-Key': CONFIG.enrollmentKey,
    ...(options.recoveryRecord
      ? { Authorization: `ClassPilot-Recovery ${options.recoveryRecord.token}` }
      : options.continuityRecord
        ? { Authorization: `ClassPilot-Device ${options.continuityRecord.proof}` }
      : {}),
  };
  let response;
  let data;
  let jsonValid = true;
  try {
    if (useFastAuthGate) {
      ({ response, data, jsonValid } = await fetchAuthGateRequest(requestUrl, {
        cache: 'no-store',
        headers: requestHeaders,
      }));
    } else {
      response = await fetchWithBackoff(requestUrl, {
        cache: 'no-store',
        headers: requestHeaders,
      }, {
        context: 'login roster',
        maxAttempts: 2,
        respectGlobalBackoff: false,
      });
      try {
        data = await response.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          data = {};
          jsonValid = false;
        }
      } catch {
        data = {};
        jsonValid = false;
      }
    }
  } catch (error) {
    if (requestIsStale()) return staleResult();
    if (!useFastAuthGate) throw error;
    return {
      success: false,
      setupRequired: false,
      unavailable: true,
      phase: 'unavailable',
      refreshAfterMs: loginRosterRefreshAfterMs(),
      error: error?.code === 'AUTH_GATE_TIMEOUT'
        ? 'Roster request timed out'
        : 'Could not reach ClassPilot to load the roster',
    };
  }
  if (requestIsStale()) return staleResult();
  if (
    options.continuityRecord
    && isManagedDeviceContinuityUnauthorized(response, data)
  ) {
    await clearManagedDeviceContinuityState(options.continuityRecord.generation);
    return {
      success: false,
      stale: true,
      phase: getAuthGateState().phase,
      error: 'Managed device sign-in authority changed; refresh names',
    };
  }
  if (response.ok && (!jsonValid || !isValidLoginRosterPayload(data))) {
    return {
      success: false,
      setupRequired: false,
      unavailable: true,
      phase: 'unavailable',
      refreshAfterMs: loginRosterRefreshAfterMs(),
      error: 'ClassPilot returned an invalid roster response',
    };
  }
  if (
    response.ok
    && options.continuityRecord
    && data.managedDeviceContinuityAccepted !== true
  ) {
    // A mixed-version backend may ignore the unfamiliar Authorization scheme
    // and return an ordinary 200 roster. Never mistake that response for proof
    // acceptance or cache it as a managed-device snapshot.
    return {
      success: false,
      continuityFallbackRequired: true,
      error: 'Managed device continuity is not available on this server',
    };
  }
  if (!response.ok) {
    const unavailable = isUnavailableAuthGateResponse(response);
    return {
      success: false,
      setupRequired: useFastAuthGate
        ? !unavailable && (response.status === 400 || response.status === 401 ||
          response.status === 403 || response.status === 404 || response.status === 422)
        : response.status === 401 || response.status === 404,
      unavailable,
      phase: unavailable ? 'unavailable' : 'setup_required',
      refreshAfterMs: unavailable
        ? Math.max(parseRetryAfterMs(response), loginRosterRefreshAfterMs())
        : undefined,
      pinLoginEnabled: data.loginMethod !== 'email_id',
      loginMethod: data.loginMethod === 'email_id' ? 'email_id' : 'name_pin',
      error: data.error || 'Could not load roster',
    };
  }
  return {
    success: true,
    students: normalizeLoginRosterStudents(data.students),
    grades: normalizeLoginRosterGrades(data.grades),
    loginMethod: data.loginMethod === 'email_id' ? 'email_id' : 'name_pin',
    pinLoginEnabled: data.loginMethod !== 'email_id',
    refreshAfterMs: loginRosterRefreshAfterMs(),
  };
}

async function applyClassroomStateFromAuthResponse(data, reason, options = {}) {
  if (!data) return;
  if (options.authMutationHeld !== true) {
    const queuedAuthContext = options.authContext || (() => {
      try {
        return captureAuthenticatedContext(`${reason} classroom response queue`);
      } catch {
        return null;
      }
    })();
    return enqueueStudentAuthMutation(async () => {
      if (queuedAuthContext) {
        assertAuthenticatedContextCurrent(
          queuedAuthContext,
          `${reason} classroom response queue`,
        );
      }
      return applyClassroomStateFromAuthResponse(data, reason, {
        ...options,
        authContext: queuedAuthContext,
        authMutationHeld: true,
      });
    });
  }
  const authContext = options.authContext || (() => {
    try {
      return captureAuthenticatedContext(`${reason} classroom response`);
    } catch {
      return null;
    }
  })();
  const assertCurrent = (label = `${reason} classroom response`) => {
    if (authContext) assertAuthenticatedContextCurrent(authContext, label);
  };
  const responseBinding = exactStudentBinding(data);
  if (responseBinding.studentId || responseBinding.studentSessionId) {
    assertCurrentStudentBinding(data, `${reason} classroom response`, { authContext });
  }
  if (responseBinding.bindingVersion === 2 && authContext) {
    observeExactStudentControlRevision(data, authContext, `${reason} response control revision`);
  }
  const fabState = data.fabState || data.fab || data.settings?.fab;
  if (!Object.prototype.hasOwnProperty.call(data, 'classroomState')) {
    if (fabState) {
      await applyFabSettings(
        { ...fabState, reason: fabState.reason || reason },
        { authContext, authorityEnvelope: data },
      );
      assertCurrent();
    }
    return;
  }
  const snapshot = data.classroomState;
  await classroomStateRestorePromise;
  assertCurrent();
  const storedBinding = await getStoredAuthState([CLASSROOM_STATE_STUDENT_BINDING_KEY]);
  assertCurrent();
  const boundStudentId = storedBinding[CLASSROOM_STATE_STUDENT_BINDING_KEY] || null;
  if (
    currentClassroomState
    && (!boundStudentId || boundStudentId !== CONFIG.activeStudentId)
  ) {
    await clearTeacherSessionStateForSignOut({ emitEvent: false, reason: `${reason}_student_changed` });
    assertCurrent();
  }
  if (!snapshot) {
    await clearTeacherSessionStateForSignOut({
      emitEvent: false,
      reason: `${reason}_no_state`,
      preserveTransientOverlays: true,
    });
    assertCurrent();
    if (CONFIG.activeStudentId) {
      await setManualAuthState({
        [CLASSROOM_STATE_STUDENT_BINDING_KEY]: CONFIG.activeStudentId,
      });
      assertCurrent();
    }
    if (fabState) {
      await applyFabSettings(
        { ...fabState, reason: fabState.reason || reason },
        { authContext, authorityEnvelope: data },
      );
      assertCurrent();
    }
    return;
  }
  try {
    // This response was read only after the server revalidated the exact new
    // student/session/device token binding. It is authoritative across student
    // changes on a shared device, where revisions are not comparable between
    // the old and new student's independent control rows.
    await applyClassroomState(snapshot, { reason, authContext, authorityEnvelope: data });
    assertCurrent();
    if (CONFIG.activeStudentId) {
      await setManualAuthState({
        [CLASSROOM_STATE_STUDENT_BINDING_KEY]: CONFIG.activeStudentId,
      });
      assertCurrent();
    }
  } catch (error) {
    console.warn('[Classroom State] Login snapshot failed:', safeDiagnosticError(error));
    requestClassroomStateSync(`${reason}-failed`, true);
    if (options.requireApplied === true) throw error;
  }
  if (fabState) {
    await applyFabSettings(
      { ...fabState, reason: fabState.reason || reason },
      { authContext, authorityEnvelope: data },
    );
    assertCurrent();
  }
}

function assertAuthGatePolicyGuardCurrentAfterCanonicalSchoolAdoption(guard, reason) {
  let priorBinding;
  try {
    const [serverOrigin, schoolId, schoolSlug] = JSON.parse(guard?.bindingKey || '[]');
    priorBinding = { serverOrigin, schoolId, schoolSlug };
  } catch {
    throw authMutationSuperseded(reason);
  }
  const currentBinding = authGateConfigBinding();
  if (
    !guard
    || guard.managedPolicyGeneration !== managedAuthGatePolicyGeneration
    || guard.configGeneration !== sharedSignInConfigGeneration
    || priorBinding.serverOrigin !== (currentBinding.serverOrigin || '')
    || (priorBinding.schoolId && priorBinding.schoolId !== currentBinding.schoolId)
    || priorBinding.schoolSlug !== (currentBinding.schoolSlug || '')
  ) {
    throw authMutationSuperseded(reason);
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
  const mutationGeneration = advanceStudentAuthMutationGeneration();
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
    const successfulResponseFailure = manualStudentLoginSuccessfulResponseFailures.has(
      mutationGeneration,
    );
    if (
      successfulResponseFailure
      && (
        studentAuthMutationGeneration === mutationGeneration
        || studentAuthCommitPendingGeneration === mutationGeneration
      )
    ) {
      // The backend may have committed a session even though validation or a
      // later local adoption step rejected its 2xx response. Exact cleanup was
      // already attempted while the response-scoped authority was in memory;
      // finish by durably removing every local credential before rejecting.
      try {
        await clearStudentAuth('student_login_response_rejected', {
          notifyBackend: false,
          pauseAutoRegistration: true,
        });
      } catch (cleanupError) {
        failAuthCommitRecoveryBarrier(cleanupError);
        console.warn('[Auth] Failed rejected-login cleanup:', safeDiagnosticError(cleanupError));
      }
    } else if (studentAuthCommitPendingGeneration === mutationGeneration) {
      // Raising clearStudentAuth's fence is synchronous. Comprehensive local
      // and backend cleanup can finish behind the rejected login response.
      clearStudentAuth('student_login_commit_failed', {
        notifyBackend: true,
        pauseAutoRegistration: true,
      }).catch((cleanupError) => {
        failAuthCommitRecoveryBarrier(cleanupError);
        console.warn('[Auth] Failed login commit cleanup:', safeDiagnosticError(cleanupError));
      });
    }
    throw error;
  } finally {
    manualStudentLoginSuccessfulResponseFailures.delete(mutationGeneration);
    if (manualStudentLoginPendingGeneration === mutationGeneration) {
      manualStudentLoginPendingGeneration = 0;
    }
  }
}

async function manualStudentLoginNow(payload, mutationGeneration, policyGuard) {
  assertAuthGatePolicyGuardCurrent(policyGuard, 'student login request');
  if (!hasSessionStorage()) {
    throw new Error('Secure student session storage is unavailable');
  }
  if (!canUseStudentLoginAuthority()) {
    throw new Error('ClassPilot student sign-in is not configured');
  }
  const deviceId = await ensureDeviceId();
  assertAuthGatePolicyGuardCurrent(policyGuard, 'student login request');
  if (!canUseStudentLoginAuthority()) {
    throw new Error('ClassPilot student sign-in is not configured');
  }
  const isPinLogin = payload.mode === 'pin';
  let recoveryGrant;
  if (isPinLogin) {
    recoveryGrant = recoveryGrantForStudentLogin(payload.studentId, payload.recoveryGrantId);
    if (payload.recoveryGrantId && !recoveryGrant) {
      throw new Error('The student sign-in list changed. Refresh names and try again.');
    }
  } else {
    // Email/ID login has no prior roster request to mint a managed-device
    // grant. Attempt continuity first even when exact recovery is available,
    // then fall back to that recovery capability if enterprise proof issuance
    // is unavailable during rollout.
    await requestManagedDeviceContinuityProof({
      recoveryRecord: matchingStudentSessionRecoveryRecord(),
    });
    recoveryGrant = recoveryGrantForEmailStudentLogin();
  }
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

  const loginServerUrl = CONFIG.serverUrl;
  const loginServerOrigin = normalizedServerOrigin(loginServerUrl);
  let response;
  let data;
  let mixedVersionRecoveryRetried = false;
  while (true) {
    const loginAuthorization = loginAuthorizationHeader(recoveryGrant);
    response = await fetchWithBackoff(`${loginServerUrl}/api/extension/student-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(CONFIG.enrollmentKey ? { 'X-ClassPilot-Enrollment-Key': CONFIG.enrollmentKey } : {}),
        ...(loginAuthorization
          ? { Authorization: loginAuthorization }
          : {}),
      },
      body: JSON.stringify(body),
    }, {
      context: 'student login',
      maxAttempts: 1,
      respectGlobalBackoff: false,
    });
    data = await response.json().catch(() => ({}));

    // During a bounded mixed-version rollout, an older backend can silently
    // ignore the new ClassPilot-Device credential and report the still-active
    // random-device session as a conflict. This can affect email/ID directly,
    // or PIN if the backend rolls back after a proof-aware roster was fetched.
    // Only that exact conflict, without the backend's proof-acceptance marker,
    // may retry once with the exact current recovery capability. Wrong PIN,
    // invalid credentials, and arbitrary errors never receive this retry.
    const exactRecovery = matchingStudentSessionRecoveryRecord();
    const canRetryWithExactRecovery = !mixedVersionRecoveryRetried
      && !response.ok
      && response.status === 409
      && data?.code === 'STUDENT_SESSION_ACTIVE'
      && data?.managedDeviceContinuityAccepted !== true
      && recoveryGrant?.authorizationKind === 'device'
      && recoveryGrant.recoveryGeneration
      && exactRecovery?.generation === recoveryGrant.recoveryGeneration
      && exactRecovery.serverOrigin === recoveryGrant.serverOrigin
      && exactRecovery.schoolId === recoveryGrant.schoolId;
    if (!canRetryWithExactRecovery) break;

    assertAuthMutationCurrent(
      mutationGeneration,
      'student login continuity fallback',
      { allowInvalidating: true },
    );
    assertAuthGatePolicyGuardCurrent(policyGuard, 'student login continuity fallback');
    const cleared = await clearManagedDeviceContinuityState(recoveryGrant.recordGeneration);
    assertAuthMutationCurrent(
      mutationGeneration,
      'student login continuity fallback',
      { allowInvalidating: true },
    );
    assertAuthGatePolicyGuardCurrent(policyGuard, 'student login continuity fallback');
    if (!cleared) break;
    const fallbackGrant = recoveryAuthorizationGrantForRecord(exactRecovery);
    if (!fallbackGrant) break;
    recoveryGrant = fallbackGrant;
    mixedVersionRecoveryRetried = true;
  }
  if (!response.ok) {
    if (
      recoveryGrant?.authorizationKind === 'device'
      && isManagedDeviceContinuityUnauthorized(response, data)
    ) {
      await clearManagedDeviceContinuityState(recoveryGrant.recordGeneration);
    }
    assertAuthMutationCurrent(
      mutationGeneration,
      'student login response',
      { allowInvalidating: true },
    );
    assertAuthGatePolicyGuardCurrent(policyGuard, 'student login response');
    throw buildResponseError(response, data, 'Invalid student credentials');
  }

  // A successful response may already represent a committed server session.
  // Capture both one-shot cleanup authorities before any policy assertion,
  // shape validation, storage write, or UI adoption can reject the response.
  // The bearer remains request-local and is never persisted.
  const authContextId = generateAuthContextId();
  const responseEffectiveDeviceId = data.effectiveDeviceId === undefined
    ? null
    : normalizeEffectiveDeviceId(data.effectiveDeviceId);
  const successfulResponseCleanupAuthority = captureSuccessfulManualLoginCleanupAuthority(
    data,
    {
      authContextId,
      deviceId: responseEffectiveDeviceId || deviceId,
      requestSchoolId: body.schoolId,
      serverOrigin: loginServerOrigin,
    },
  );
  try {
    assertAuthMutationCurrent(
      mutationGeneration,
      'student login response',
      { allowInvalidating: true },
    );
    assertAuthGatePolicyGuardCurrent(policyGuard, 'student login response');
    if (!data.studentToken) {
      throw buildResponseError(response, data, 'Invalid student credentials');
    }
    if (
      recoveryGrant?.authorizationKind === 'device'
      && data.managedDeviceContinuityAccepted !== true
    ) {
      await clearManagedDeviceContinuityState(recoveryGrant.recordGeneration);
      throw new Error('ClassPilot did not acknowledge managed device continuity');
    }
    if (data.effectiveDeviceId !== undefined && !responseEffectiveDeviceId) {
      if (recoveryGrant?.authorizationKind === 'device') {
        await clearManagedDeviceContinuityState(recoveryGrant.recordGeneration);
      }
      throw new Error('ClassPilot returned an invalid effective device binding');
    }
    if (recoveryGrant?.authorizationKind === 'device' && !responseEffectiveDeviceId) {
      await clearManagedDeviceContinuityState(recoveryGrant.recordGeneration);
      throw new Error('ClassPilot omitted the managed device binding');
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
  const recoveryToken = normalizeStudentSessionRecoveryToken(data.sessionRecovery?.token);
  const recoveryServerOrigin = loginServerOrigin;
  if (!recoveryToken || !authenticatedSchoolId || !recoveryServerOrigin) {
    throw new Error('ClassPilot did not provide secure session recovery');
  }
  const identitySource = isPinLogin ? 'manual_pin' : 'manual_email_id';
  const effectiveDeviceId = responseEffectiveDeviceId || deviceId;

  await beginStudentAuthCommit(mutationGeneration, 'student login commit');

  // Clear the local crash-recovery marker before dispatching the session
  // storage commit. A reset requested later writes `true` afterward and wins.
  const markerCleared = durableLocalKv.remove(STUDENT_AUTH_INVALIDATING_KEY);
  await durableLocalKv.set({
    deviceId: effectiveDeviceId,
    classId: 'auto',
    config: persistedNonAuthConfig({
      ...CONFIG,
      deviceId: effectiveDeviceId,
      classId: 'auto',
      ...(authenticatedSchoolId ? { schoolId: authenticatedSchoolId } : {}),
    }),
  });
  const provisionalRecoveryAuthority = {
    state: 'armed',
    generation: generateStudentSessionRecoveryGeneration(),
    serverOrigin: recoveryServerOrigin,
    schoolId: authenticatedSchoolId,
    token: recoveryToken,
    authContextId,
    createdAt: now,
  };
  await armStudentSessionRecovery(provisionalRecoveryAuthority, {
    discardGeneration: recoveryGrant?.authorizationKind === 'device'
      ? recoveryGrant.recoveryGeneration
      : recoveryGrant?.recordGeneration,
  });
  await setManualAuthState({
    authContextId,
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
  CONFIG.deviceId = effectiveDeviceId;
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
  if (recoveryGrant?.authorizationKind === 'device') {
    await clearManagedDeviceContinuityState(recoveryGrant.recordGeneration);
  }
  activateAuthenticatedContext(authContextId);
  const committedAuthContext = capturePendingAuthenticatedContext(
    'student login storage adoption',
    mutationGeneration,
  );
  await cleanupRetiredExactBoundStorage(
    committedAuthContext,
    'student login storage adoption',
  );
  adoptNegotiatedProtocolState(data, committedAuthContext);
  assertAuthMutationCurrent(mutationGeneration, 'student login');
  assertAuthGatePolicyGuardCurrentAfterCanonicalSchoolAdoption(
    policyGuard,
    'student login adoption',
  );
  resetSharedSignInLoginConfigCache({ clearPersisted: true });
  // Authentication intentionally invalidates the pre-login presentation
  // generation, and a slug-based setup may learn its canonical schoolId from
  // this authoritative response. Capture that expected post-adoption binding
  // while retaining the managed-policy generation that authorized the request.
  const committedPolicyGuard = captureAuthGatePolicyGuard();
  if (committedPolicyGuard.managedPolicyGeneration !== policyGuard.managedPolicyGeneration) {
    throw authMutationSuperseded('student login adoption');
  }
  await reconcileMessageInboxIdentity('student-login', {
    authContext: committedAuthContext,
    expectedBinding: monitoringEventAuthBindingForContext(committedAuthContext),
  });

  // Login-provided classroom restrictions are local enforcement authority and
  // must be reconciled before any page unlocks. License/settings refreshes are
  // not part of that critical path.
  await applyClassroomStateFromAuthResponse(data, 'student_login', {
    requireApplied: true,
    authContext: committedAuthContext,
    authMutationHeld: true,
  });
  assertAuthMutationCurrent(mutationGeneration, 'student login');
  assertAuthGatePolicyGuardCurrent(committedPolicyGuard, 'student login adoption');
  await completeStudentAuthCommit(mutationGeneration, 'student login commit');
  assertAuthGatePolicyGuardCurrent(committedPolicyGuard, 'student login adoption');
  await replayClassroomUiForAuth(committedAuthContext, 'student login UI replay');
  assertAuthGatePolicyGuardCurrent(committedPolicyGuard, 'student login adoption');
  await activateLicenseForAuthenticatedResponse(
    committedAuthContext,
    data.planStatus,
    { notify: false },
  );
  assertAuthGatePolicyGuardCurrent(committedPolicyGuard, 'student login adoption');
  if (trackingState !== TRACKING_STATES.OFF) connectWebSocket().catch(() => {});

  const committedAuthBinding = {
    deviceId: CONFIG.deviceId,
    studentToken: CONFIG.studentToken,
    studentId: CONFIG.activeStudentId,
    studentSessionId: CONFIG.activeStudentSessionId,
  };
  // Start the cross-tab authenticated push immediately, but do not make the
  // initiating tab wait for every tab message/injection attempt to settle.
  notifyAuthGateStateToTabs({ triggerRefresh: false }).catch((error) => {
    console.warn('[Auth Gate] Post-login broadcast failed:', safeDiagnosticError(error));
  });

  Promise.resolve().then(async () => {
    assertAuthMutationBindingCurrent(
      mutationGeneration,
      committedAuthBinding,
      'post-login initialization',
    );
    const trackingInitialization = initializeAdaptiveTracking('manual-login', {
      authMutationGeneration: mutationGeneration,
      authBinding: committedAuthBinding,
    });
    const licenseRefresh = checkLicenseStatus('manual-login', {
      authMutationGeneration: mutationGeneration,
      authBinding: committedAuthBinding,
      deferTrackingInitialization: true,
    });
    await Promise.all([trackingInitialization, licenseRefresh]);
    assertAuthMutationBindingCurrent(
      mutationGeneration,
      committedAuthBinding,
      'post-login initialization',
    );
  }).catch((error) => {
    if (error?.code === 'AUTH_MUTATION_SUPERSEDED') {
      console.info('[Auth] Post-login initialization superseded');
      return;
    }
    console.warn('[Auth] Post-login initialization failed:', safeDiagnosticError(error));
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
  } catch (error) {
    try {
      await cleanupSuccessfulManualLoginResponse(
        successfulResponseCleanupAuthority,
        'student_login_response_rejected',
      );
    } catch (cleanupError) {
      // Cleanup failures must not mask the validation/adoption failure. A
      // retryable exact recovery token is persisted by the helper whenever
      // storage remains available; no reusable bearer escapes this request.
      console.warn('[Auth] Rejected-login server cleanup failed:', safeDiagnosticError(cleanupError));
    }
    manualStudentLoginSuccessfulResponseFailures.add(mutationGeneration);
    throw error;
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
    console.warn('[Service Worker] Email normalization failed:', safeDiagnosticError(err));
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
        console.log(`[Service Worker] Could not get profile info (attempt ${attempt + 1}):`, safeDiagnosticError(err));
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

    // Read browser-session authority before deciding whether registration
    // needs server configuration. A complete persisted binding can be restored
    // concurrently with this call, before CONFIG's in-memory mirror catches up.
    const serverUrl = CONFIG.serverUrl || DEFAULT_SERVER_URL;
    let stored = await getStoredAuthState([
      'authContextId',
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

    const storedHasExactStudentAuth = [
      stored.studentToken,
      stored.activeStudentId,
      stored.activeStudentSessionId,
    ].every((value) => typeof value === 'string' && value.trim().length > 0);
    // A complete browser-session binding is already authoritative for this
    // worker wake. Do not make the local-auth fast path depend on, or even
    // start, login-configuration network I/O. Managed policy was resolved by
    // the wake barrier before this function is reached, and unauthenticated
    // registration still refreshes the server configuration below.
    if (!hasStudentAuth() && !storedHasExactStudentAuth) {
      await fetchClientConfig(serverUrl);
    }
    applyManagedSchoolConfig(await readManagedConfig());

    if (stored[STUDENT_AUTH_INVALIDATING_KEY] === true) {
      studentAuthInvalidating = true;
      CONFIG.autoRegistrationPaused = true;
      return stored;
    }

    await ensureStudentSessionRecoveryLoaded();
    if (studentSessionRecoveryStateHasRecords() && !hasStudentAuth()) {
      CONFIG.autoRegistrationPaused = true;
      stored.autoRegistrationPaused = true;
      await durableLocalKv.set({ autoRegistrationPaused: true });
      console.log('[Auth] Recovery requires deliberate student sign-in; profile registration paused');
      await notifyAuthGateStateToTabs();
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
        console.log('[Service Worker] Chrome profile identity changed; re-registering');
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
          authContextId: null,
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
    
    // Student credentials and identity are browser-session authority for both
    // shared-device and managed-profile authentication. The stable anonymous
    // device identifier and non-sensitive pause control may remain durable.
    const sessionAuthState = {};
    for (const key of SESSION_ONLY_STUDENT_AUTH_KEYS) {
      if (key in stored) sessionAuthState[key] = stored[key];
    }
    await setManualAuthState(sessionAuthState);
    await kv.set({
      deviceId: stored.deviceId,
      autoRegistrationPaused: stored.autoRegistrationPaused === true,
    });
    assertAuthMutationCurrent(registrationGeneration, 'student registration restore');
    
    // Update CONFIG (email is primary identity - backend will determine schoolId from email domain)
    CONFIG.studentEmail = stored.studentEmail;
    CONFIG.studentName = stored.studentName || (stored.studentEmail ? stored.studentEmail.split('@')[0] : stored.studentEmail);
    CONFIG.deviceId = stored.deviceId;
    CONFIG.classId = 'auto'; // Backend determines this from email domain
    CONFIG.activeStudentId = stored.activeStudentId || CONFIG.activeStudentId;
    CONFIG.activeStudentSessionId = stored.activeStudentSessionId || CONFIG.activeStudentSessionId;
    CONFIG.authContextId = stored.authContextId || CONFIG.authContextId;
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
        const authContextId = generateAuthContextId();
        await enqueueStudentAuthMutation(async () => {
          assertAuthMutationCurrent(registrationGeneration, 'student registration');
          await beginStudentAuthCommit(
            registrationGeneration,
            'student registration commit',
          );
          const markerCleared = durableLocalKv.remove(STUDENT_AUTH_INVALIDATING_KEY);
          const durableStatePersisted = durableLocalKv.set({
            autoRegistrationPaused: false,
            ...(authenticatedSchoolId ? {
              config: persistedNonAuthConfig({ ...CONFIG, schoolId: authenticatedSchoolId }),
            } : {}),
          });
          await setManualAuthState({
            authContextId,
            studentToken: data.studentToken,
            activeStudentId: studentId,
            activeStudentSessionId: studentSessionId,
            studentEmail: stored.studentEmail,
            studentName: CONFIG.studentName,
            identitySource: 'chrome_profile',
            manualLoginLastSeenAt: null,
            registered: true,
            lastRegisteredEmail: stored.studentEmail,
          });
          await Promise.all([markerCleared, durableStatePersisted]);
          assertAuthMutationCurrent(registrationGeneration, 'student registration');
          CONFIG.studentToken = data.studentToken;
          CONFIG.activeStudentId = studentId;
          CONFIG.activeStudentSessionId = studentSessionId;
          CONFIG.identitySource = 'chrome_profile';
          if (authenticatedSchoolId) CONFIG.schoolId = authenticatedSchoolId;
          CONFIG.manualLoginLastSeenAt = null;
          CONFIG.autoRegistrationPaused = false;
          studentAuthInvalidating = false;
          activateAuthenticatedContext(authContextId);
          const committedAuthContext = capturePendingAuthenticatedContext(
            'student registration storage adoption',
            registrationGeneration,
          );
          await cleanupRetiredExactBoundStorage(
            committedAuthContext,
            'student registration storage adoption',
          );
          adoptNegotiatedProtocolState(data, committedAuthContext);
          assertAuthMutationCurrent(registrationGeneration, 'student registration');
          await reconcileMessageInboxIdentity('student-registration', {
            authContext: committedAuthContext,
            expectedBinding: monitoringEventAuthBindingForContext(committedAuthContext),
          });
          await applyClassroomStateFromAuthResponse(
            data,
            'student_registration',
            {
              requireApplied: true,
              authContext: committedAuthContext,
              authMutationHeld: true,
            },
          );
          assertAuthMutationCurrent(registrationGeneration, 'student registration');
          await completeStudentAuthCommit(
            registrationGeneration,
            'student registration commit',
          );
          await replayClassroomUiForAuth(
            committedAuthContext,
            'student registration UI replay',
          );
          await activateLicenseForAuthenticatedResponse(
            committedAuthContext,
            data.planStatus,
            { notify: false },
          );
          if (trackingState !== TRACKING_STATES.OFF) connectWebSocket().catch(() => {});
        });
        initializeAdaptiveTracking('registration-success').catch(() => {});
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
            warnAuthCleanupFailure(
              '[Auth] Failed Chrome-profile registration commit cleanup:',
              cleanupError,
            );
            return stored;
          }
        }
        if (error?.code === 'AUTH_MUTATION_SUPERSEDED') {
          console.info('[Auth] Ignoring superseded student registration response');
          return stored;
        }
        console.warn('[Service Worker] Student registration error:', safeDiagnosticError(error));
        await enqueueStudentAuthMutation(async () => {
          assertAuthMutationCurrent(registrationGeneration, 'student registration failure');
          await durableLocalKv.remove(SESSION_ONLY_STUDENT_AUTH_KEYS);
          if (hasSessionStorage()) await durableSessionKv.remove(SESSION_ONLY_STUDENT_AUTH_KEYS);
          assertAuthMutationCurrent(registrationGeneration, 'student registration failure');
          CONFIG.studentToken = null;
          CONFIG.authContextId = null;
          abortActiveAuthContext();
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

    checkLicenseStatus('registration').catch(() => {});
    await notifyAuthGateStateToTabs();
    
    return stored;
  } catch (error) {
    console.warn('[Service Worker] Registration failed:', safeDiagnosticError(error));
    // Don't throw - extension can still work with defaults
    return {};
  }
}

// Run auto-registration on install and startup
chrome.runtime.onInstalled.addListener((details = {}) => {
  console.log('[Service Worker] Extension installed/updated');
  disableToolbarAction();
  authStateRestorePromise
    .then(() => awaitManagedAuthGatePolicyStable())
    .then(async () => {
      // Updates are browser-level manual-auth boundaries even on Chrome builds
      // that retain storage.session. A normal MV3 worker suspension never
      // takes this path and therefore preserves the current login.
      if (details.reason === 'update' && isManualIdentitySource() && hasStudentAuth()) {
        await clearStudentAuth('extension_update', {
          notifyBackend: true,
          awaitBackendSignOut: true,
          pauseAutoRegistration: true,
          preserveRecoveryForGate: true,
        });
      }
      flushStudentSessionRecovery({ maxRecords: 1 }).catch(() => {});
      scheduleLicenseCheck();
      ensureRegistered().catch(() => {});
      scheduleJitteredStartup('install', () => initializeAdaptiveTracking('install').catch(() => {}));
    }).catch(err => {
      console.warn('[Service Worker] Install init error (will retry):', safeDiagnosticError(err));
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
        console.warn('[Service Worker] Startup init error (will retry):', safeDiagnosticError(err));
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
  // Chrome notifications outlive MV3 worker memory. Reconcile the persisted
  // extension-owned inventory on every wake before any new teacher message is
  // allowed to create a notification; failures retain a durable retry alarm.
  authBoundNotificationCleanupPromise = ensureAuthBoundNotificationInventory({ force: true });
  const wakePolicyGeneration = advanceManagedAuthGatePolicyGeneration();
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
    'authContextId',
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
    STUDENT_SESSION_RECOVERY_STORAGE_KEY,
    AUTH_GATE_ROSTER_CONTEXT_STORAGE_KEY,
  ]);
  const storedServerUrl = authStored.config?.serverUrl;
  const fastResolvedServerUrl = isHttpUrl(storedServerUrl)
    ? storedServerUrl
    : isHttpUrl(INJECTED_SERVER_URL) ? INJECTED_SERVER_URL : DEFAULT_SERVER_URL;
  const legacySchoolPolicyOwnerScopeAtWake = schoolPolicyScope(
    fastResolvedServerUrl,
    authStored.config?.schoolId,
  );
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
    manualAuthSessionStorageUnavailable,
  } = restoredAuth;
  const allowUnmanagedFallback = (explicitUnmanagedDevelopment
    || isExplicitUnmanagedDevelopmentServer(fastResolvedServerUrl))
    && !authStored[MANAGED_AUTH_GATE_BINDING_KEY];
  let managedAuthBindingChanged = false;
  let managedPolicyChanged = false;
  let managedSetupUnavailable = false;
  let workerWakeRestrictionSsoCleanup = Promise.resolve();
  const applyWorkerWakeManagedPolicy = ({ config, error }, notifyAfter = false) => {
    managedAuthBindingChanged = managedPolicyConflictsWithStoredAuth(
      authStored,
      config,
      fastResolvedServerUrl,
      { allowUnmanagedFallback, managedReadFailed: Boolean(error) },
    );
    if (error) {
      managedPolicyChanged = true;
      managedSetupUnavailable = true;
      managedAuthGateSetupUnavailable = true;
      authoritativeManagedSchoolPolicyScope = null;
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
      managedPolicyChanged = appliedPolicy.policyIsAuthoritative
        && !managedAuthGatePolicyDescriptorsMatch(
          authStored[MANAGED_AUTH_GATE_BINDING_KEY],
          appliedPolicy.persistedDescriptor,
        );
      if (
        appliedPolicy.policyIsAuthoritative
        && normalizeManagedString(authStored.config?.enrollmentKey)
          !== appliedPolicy.descriptor.enrollmentKey
      ) {
        // The persisted descriptor records only whether the secret is
        // managed. Compare its already-persisted config value in memory so an
        // enrollment-key rotation while signed out also retires the ledger.
        managedPolicyChanged = true;
      }
    }
    if (managedPolicyChanged) {
      workerWakeRestrictionSsoCleanup = workerWakeRestrictionSsoCleanup
        .then(() => clearRestrictionSsoVisitState());
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
    if (notifyAfter) {
      workerWakeRestrictionSsoCleanup
        .then(() => notifyAuthGateStateToTabs({ triggerRefresh: false }))
        .catch(() => {});
    }
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
  await workerWakeRestrictionSsoCleanup;
  restoreSharedSignInPresentationCache(authStored[SHARED_SIGN_IN_CONFIG_CACHE_KEY]);
  await reconcileStudentSessionRecoveryAtWorkerWake(authStored, {
    authRestoreBlocked: interruptedAuthClear
      || interruptedAuthCommit
      || manualAuthTimestampInvalid
      || manualAuthSessionStorageUnavailable
      || managedAuthBindingChanged,
    preserveForGate: !interruptedAuthClear
      && !manualAuthTimestampInvalid
      && !managedAuthBindingChanged,
  });
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
  try {
    await reconcileAuthGateRosterContext(
      authStored[AUTH_GATE_ROSTER_CONTEXT_STORAGE_KEY],
    );
    await awaitAuthGateRosterContextStable();
  } catch (error) {
    if (!authGateRosterContextReady) rejectAuthGateRosterContextReady(error);
    throw error;
  }
  // Ordinary cold start can release the page gate as soon as the local
  // credential snapshot is resolved. Crash-recovery paths must keep the
  // barrier pending until their durable invalidation markers are removed;
  // otherwise callers can observe a fail-closed UI while recovery is still
  // only half committed on disk.
  if (
    !interruptedAuthClear
    && !interruptedAuthCommit
    && !manualAuthTimestampInvalid
    && !manualAuthSessionStorageUnavailable
  ) {
    markAuthStateRestored();
  }
  const assertWorkerWakeCurrent = () => assertAuthMutationCurrent(
    workerWakeRestoreGeneration,
    'worker wake restore',
    {
      allowInvalidating: interruptedAuthClear
        || interruptedAuthCommit
        || manualAuthTimestampInvalid
        || manualAuthSessionStorageUnavailable
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
    LICENSE_STATE_SCOPE_KEY,
    LICENSE_LAST_VERIFIED_AT_KEY,
    'globalBlockedDomains',
    GLOBAL_BLOCKED_DOMAINS_SCOPE_KEY,
    'teacherBlockListState',
    'classroomControlStateV1',
    'classroomStateFailSafeExpiryAt',
    'classroomStateStudentBindingV1',
    MONITORING_STATE_STORAGE_KEY,
    MONITORING_STATE_SCOPE_KEY,
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
    STUDENT_CHAT_OUTBOX_KEY,
    STUDENT_CHAT_OUTBOX_BINDING_KEY,
    TAB_SNAPSHOT_STORAGE_KEY,
    STUDENT_AUTH_INVALIDATING_KEY,
    SHARED_SIGN_IN_CONFIG_CACHE_KEY,
  ]);
  // Rebuild retention alarms and physically remove expired sensitive outbox
  // rows on every MV3 wake, even when no student is signed in and therefore no
  // network flush is permitted.
  await Promise.all([
    compactCommandAckStorageOnly(),
    compactChatAckStorageOnly(),
    compactStudentChatStorageOnly(),
  ]);
  assertWorkerWakeCurrent();
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
  let workerWakeAuthContext = null;
  try {
    workerWakeAuthContext = captureAuthenticatedContext('worker entitlement restore');
  } catch {
    workerWakeAuthContext = null;
  }
  const expectedMonitoringScope = workerWakeAuthContext
    ? monitoringEventAuthBindingForContext(workerWakeAuthContext)
    : null;
  if (
    storedMonitoringState
    && expectedMonitoringScope
    && stored[MONITORING_STATE_SCOPE_KEY] === expectedMonitoringScope
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
    persistedMonitoringStateScope = expectedMonitoringScope;
  }
  connectivityHealth = RuntimeCore.normalizeConnectivityHealth(
    stored[CONNECTIVITY_HEALTH_STORAGE_KEY]
  );
  lastConnectivityHealthPersistAt = Math.max(
    Number(connectivityHealth.lastSuccessAt || 0),
    Number(connectivityHealth.lastFailureAt || 0),
  );
  lastConnectivityPersistedState = RuntimeCore.connectivityHealthState(
    connectivityHealth,
    Date.now(),
  ).state;
  screenshotHealth = RuntimeCore.normalizeScreenshotHealth(
    stored[SCREENSHOT_HEALTH_STORAGE_KEY]
  );
  syncScreenshotHealthGlobals();
  assertWorkerWakeCurrent();
  await reconcileMessageInboxIdentity('worker-wake');
  assertWorkerWakeCurrent();
  if (stored[FAB_CONTEXT_STORAGE_KEY]?.binding === fabIdentityBinding()) {
    currentFabState = normalizeFabState(stored[FAB_STATE_STORAGE_KEY] || {});
    if (currentFabState.ownershipRevisionKnown === true) {
      try {
        const authContext = captureAuthenticatedContext('worker FAB control revision restore');
        observeStudentControlRevision(
          currentFabState.ownershipRevision,
          authContext,
          'worker FAB control revision restore',
        );
      } catch (error) {
        if (!isAuthContextCancellation(error)) throw error;
      }
    }
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
  if (
    stored[STUDENT_CHAT_OUTBOX_BINDING_KEY] === monitoringEventAuthBinding()
    && boundedStudentChatOutbox(stored[STUDENT_CHAT_OUTBOX_KEY])
      .some((entry) => entry.status !== 'failed')
  ) {
    scheduleStudentChatFlush(1000);
  } else if (Array.isArray(stored[STUDENT_CHAT_OUTBOX_KEY])
      && stored[STUDENT_CHAT_OUTBOX_KEY].length > 0) {
    await discardStudentChatOutbox();
  }
  if (stored[TAB_SNAPSHOT_STORAGE_KEY]?.binding === tabSnapshotAuthBinding()) {
    currentTabSnapshotRevision = Number(stored[TAB_SNAPSHOT_STORAGE_KEY].revision || 0);
  }

  // Load school policy into memory first. The classroom-state composer will
  // include it in the same atomic DNR update without allowing the two ranges
  // to erase one another.
  const expectedSchoolScope = schoolPolicyScope();
  const restoredSchoolPolicy = classifyStoredSchoolPolicy(stored, expectedSchoolScope, {
    legacyOwnerScope: legacySchoolPolicyOwnerScopeAtWake,
  });
  if (
    restoredSchoolPolicy.status === 'matched'
    || restoredSchoolPolicy.status === 'legacy_migratable'
  ) {
    globalBlockedDomains = restoredSchoolPolicy.domains;
    globalBlockedDomainsStateTrusted = true;
    globalBlockedDomainsScope = expectedSchoolScope;
    if (restoredSchoolPolicy.status === 'legacy_migratable') {
      await durableLocalKv.set({ [GLOBAL_BLOCKED_DOMAINS_SCOPE_KEY]: expectedSchoolScope });
      assertWorkerWakeCurrent();
    }
  } else if (restoredSchoolPolicy.status === 'mismatch' && expectedSchoolScope) {
    globalBlockedDomains = [];
    globalBlockedDomainsStateTrusted = true;
    globalBlockedDomainsScope = expectedSchoolScope;
    await durableLocalKv.set({
      globalBlockedDomains: [],
      [GLOBAL_BLOCKED_DOMAINS_SCOPE_KEY]: expectedSchoolScope,
    });
    assertWorkerWakeCurrent();
  } else {
    // Missing, malformed, or unowned legacy data cannot authorize a DNR
    // replacement. Preserve the surviving browser rules until an exact
    // managed owner is proven or the server supplies a fresh policy.
    globalBlockedDomains = [];
    globalBlockedDomainsStateTrusted = false;
    globalBlockedDomainsScope = null;
    console.warn('[Service Worker] Stored school block list is unverified; preserving existing rules');
  }

  assertWorkerWakeCurrent();
  const browserSessionAuthorityMissing = !hasStudentAuth();
  const authRecoveryPending = interruptedAuthClear
    || interruptedAuthCommit
    || manualAuthTimestampInvalid
    || manualAuthSessionStorageUnavailable
    || browserSessionAuthorityMissing;
  if (stored[CLASSROOM_STATE_STORAGE_KEY] && !authRecoveryPending) {
    let restoreAuthContext = null;
    try {
      restoreAuthContext = captureAuthenticatedContext('worker classroom-state restore');
      if (stored[CLASSROOM_STATE_STUDENT_BINDING_KEY] !== restoreAuthContext.studentId) {
        throw authContextSuperseded('worker classroom-state restore');
      }
      await applyClassroomState(stored[CLASSROOM_STATE_STORAGE_KEY], {
        force: true,
        reason: 'worker_wake',
        trustedPersistedRestrictionSso: true,
        authContext: restoreAuthContext,
        authorityEnvelope: {
          studentId: restoreAuthContext.studentId,
          studentSessionId: restoreAuthContext.studentSessionId,
        },
      });
      console.log('[Service Worker] Restored revisioned classroom state');
    } catch (error) {
      if (
        isAuthContextCancellation(error)
        || error?.code === 'AUTH_MUTATION_SUPERSEDED'
      ) throw error;
      // DNR rules survive an MV3 worker restart. If storage is corrupt, do not
      // clear those rules; request the authoritative server snapshot instead.
      // A separately stored deadline still prevents orphaned rules from
      // surviving forever if the server remains unreachable.
      if (!restoreAuthContext) throw error;
      await recoverInvalidStoredClassroomState(
        stored[CLASSROOM_STATE_STORAGE_KEY],
        stored[CLASSROOM_STATE_STUDENT_BINDING_KEY],
        stored.classroomStateFailSafeExpiryAt,
        restoreAuthContext,
      );
      console.warn('[Service Worker] Stored classroom state is invalid; existing rules retained:', safeDiagnosticError(error));
    }
  } else if (stored[CLASSROOM_STATE_STORAGE_KEY] && authRecoveryPending) {
    // Crash recovery deliberately does not adopt credentials. Therefore no
    // exact student/session authority exists with which to relabel or apply
    // the stored classroom snapshot. The recovery clear below removes the
    // snapshot and its surviving teacher DNR ranges before the gate opens.
    console.warn('[Service Worker] Skipping classroom restore during authentication recovery');
  } else if (stored.flightPathState || stored.lockScreenState || stored.teacherBlockListState) {
    // 2.6.x restriction records have no student/session/school authority. The
    // browser's surviving DNR rules remain fail-closed while the worker asks
    // SchoolPilot for a current exact snapshot below, but raw legacy URLs and
    // lists must never be relabelled as the student who happens to sign in.
    console.warn('[Service Worker] Unowned legacy classroom state was not adopted; awaiting exact server state');
  } else {
    // No teacher state is known. Reconcile only the school range; never clear
    // teacher ranges merely because the worker was restarted.
    if (globalBlockedDomainsStateTrusted) {
      await updateGlobalBlacklistRules(globalBlockedDomains).catch((error) => {
        console.warn('[Service Worker] School block list restore failed:', safeDiagnosticError(error));
      });
    }
  }
  assertWorkerWakeCurrent();

  console.log('[Service Worker] State restored:', {
    authenticated: hasStudentAuth(),
    flightPathActive: allowedDomains.length > 0,
    screenLocked: screenLocked,
    globalBlockedDomains: globalBlockedDomains.length,
    teacherBlockedDomains: teacherBlockedDomains.length,
    classroomRevision: currentClassroomState?.revision ?? 0,
  });
  markClassroomStateRestored();

  if (
    interruptedAuthClear
    || interruptedAuthCommit
    || manualAuthTimestampInvalid
    || manualAuthSessionStorageUnavailable
    || browserSessionAuthorityMissing
  ) {
    assertWorkerWakeCurrent();
    const recoveryReason = interruptedAuthCommit
      ? 'interrupted-auth-commit'
      : manualAuthTimestampInvalid
        ? 'manual-login-timestamp-invalid'
        : manualAuthSessionStorageUnavailable
          ? 'manual-session-storage-unavailable'
          : browserSessionAuthorityMissing
            ? 'browser-session-ended'
            : 'interrupted-auth-clear';
    const recoveryRequiresManualReauthentication = Boolean(
      studentSessionRecoveryState.armed || studentSessionRecoveryState.pending.length > 0,
    );
    await clearStudentAuth(
      recoveryReason,
      {
      notifyBackend: false,
      pauseAutoRegistration: recoveryRequiresManualReauthentication,
      preserveRecoveryForGate: recoveryReason === 'browser-session-ended'
        || recoveryReason === 'manual-session-storage-unavailable'
        || recoveryReason === 'interrupted-auth-commit',
      },
    );
    await setConnectivityBadge(connectivityStatus());
    return;
  }

  const expectedLicenseScope = workerWakeAuthContext
    ? licenseScopeForAuthContext(workerWakeAuthContext)
    : null;
  if (licenseLkgMatchesExactScope(stored, expectedLicenseScope)) {
    assertWorkerWakeCurrent();
    adoptLicenseState(true, stored.planStatus, workerWakeAuthContext, {
      verifiedAt: Number(stored[LICENSE_LAST_VERIFIED_AT_KEY]),
    });
  } else if (
    stored.licenseActive === false
    && expectedLicenseScope
    && stored[LICENSE_STATE_SCOPE_KEY] === expectedLicenseScope
  ) {
    assertWorkerWakeCurrent();
    await disableForInactiveLicense(stored.planStatus, workerWakeAuthContext, {
      verifiedAt: Number(stored[LICENSE_LAST_VERIFIED_AT_KEY]) || Date.now(),
    });
  } else {
    resetLicenseStateForAuthorityTransition();
    if (
      stored.licenseActive !== undefined
      || stored.planStatus !== undefined
      || stored[LICENSE_STATE_SCOPE_KEY] !== undefined
      || stored[LICENSE_LAST_VERIFIED_AT_KEY] !== undefined
    ) {
      await kv.remove([
        'licenseActive',
        'planStatus',
        'licenseDisabledAt',
        LICENSE_STATE_SCOPE_KEY,
        LICENSE_LAST_VERIFIED_AT_KEY,
      ]);
      assertWorkerWakeCurrent();
    }
  }

  assertWorkerWakeCurrent();
  // Local exact-scope LKG state is enough to resume tracking. Registration and
  // entitlement refresh run independently so either network path can stall or
  // retry without suppressing heartbeat/screenshot startup.
  ensureRegistered().catch(() => {});
  checkLicenseStatus('worker-wake').catch(() => {});
  scheduleMonitoringEventFlush(1000);
  requestClassroomStateSync('worker-wake', true);
  await setConnectivityBadge(connectivityStatus());
  await scheduleConnectivityHealthBoundary();

  // Hold this wake task through local settings reconciliation and tracking
  // startup. A bare jitter timer can disappear when MV3 suspends the worker,
  // recreating a monitoring blackout even though exact-scope LKG is active.
  console.log('[Service Worker] Initializing adaptive tracking...');
  await initializeAdaptiveTracking('wake');
})().catch(err => {
  // Silently handle wake-up errors (network issues, server deploys)
  // The extension will self-heal via alarms and retries
  console.warn('[Service Worker] Wake-up error (will retry):', safeDiagnosticError(err));
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
  const notificationId = String(opts?.notificationId || '').slice(0, 240);
  const { notificationId: _ignoredNotificationId, ...notificationOptions } = opts || {};
  const options = {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'ClassPilot',
    message: '',
    priority: 0,
    ...notificationOptions, // allow caller to override title/message/iconUrl if needed
  };

  try {
    // In MV3, callbacks can surface runtime.lastError; prefer Promises
    await new Promise((resolve) => {
      chrome.notifications.create(notificationId, options, () => {
        // swallow runtime.lastError quietly
        void chrome.runtime.lastError;
        resolve();
      });
    });
  } catch (e) {
    // Never use console.warn for expected conditions; keep the Errors panel clean
    console.warn('notify skipped:', safeDiagnosticError(e));
  }
}

// Declarative Net Request rules are composed through one serialized writer.
// Each feature owns a half-open ID range, so changing teacher controls cannot
// erase school policy or unrelated extension rules.
let dynamicRuleCompositionTail = Promise.resolve();

function runtimeClassroomStateForRules() {
  return {
    ...(restrictionSsoPassThroughActive ? {
      deliveryContext: { lateSignInRestrictionSso: true },
    } : {}),
    restrictions: {
      screenLock: { active: screenLocked, url: lockedUrl, domain: lockedDomain },
      flightPath: { active: allowedDomains.length > 0, allowedDomains },
      blockList: { active: teacherBlockedDomains.length > 0, blockedDomains: teacherBlockedDomains },
      attentionMode: { active: attentionModeActive },
      temporaryAllows: temporaryAllowedDomains,
    },
  };
}

function composeDynamicRules(rangeNames, options = {}) {
  const requestedRanges = [...new Set(rangeNames)].filter((name) => RuntimeCore.DNR_RANGES[name]);
  if (requestedRanges.length === 0) return Promise.resolve();

  const run = async () => {
    // Validate and build before changing Chrome state. Oversized or malformed
    // lists therefore leave the previous complete ruleset intact.
    const addRules = RuntimeCore.buildDnrRules({
      classroomState: runtimeClassroomStateForRules(),
      restrictionSsoPassThrough: restrictionSsoPassThroughActive,
      globalBlockedDomains: Object.prototype.hasOwnProperty.call(options, 'globalBlockedDomains')
        ? options.globalBlockedDomains
        : globalBlockedDomains,
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
  await composeDynamicRules(['classroom', 'restrictionSso']);
}

async function clearBlockingRules() {
  await composeDynamicRules(['classroom', 'restrictionSso']);
}

async function clearClassroomBlockingRule() {
  await composeDynamicRules(['classroom', 'restrictionSso']);
}

function updateGlobalBlacklistRules(blockedDomains, options = {}) {
  let authContext = options.authContext || null;
  if (!authContext && hasStudentAuth()) {
    authContext = captureAuthenticatedContext('school block list reservation');
  }
  const expectedScope = authContext
    ? schoolPolicyScopeForAuthContext(authContext)
    : options.scope || schoolPolicyScope();
  const normalized = RuntimeCore.normalizeDomainList(blockedDomains, 'school block list');
  if (!expectedScope) throw new Error('School block list scope is unavailable');
  const assertCurrent = (reason = 'school block list') => {
    if (authContext) {
      assertAuthenticatedContextCurrent(authContext, reason);
      if (schoolPolicyScopeForAuthContext(authContext) !== expectedScope) {
        throw authContextSuperseded(reason);
      }
      if (options.sourceMessage) {
        const binding = assertCurrentStudentBinding(options.sourceMessage, reason, { authContext });
        assertBindingMatchesAuthContext(binding, authContext, reason);
      }
    } else if (schoolPolicyScope() !== expectedScope) {
      throw authContextSuperseded(reason);
    }
  };
  const run = async () => {
    assertCurrent('school block list reservation');
    try {
      await composeDynamicRules(['school'], { globalBlockedDomains: normalized });
      assertCurrent('school block list rule application');
      await durableLocalKv.set({
        globalBlockedDomains: normalized,
        [GLOBAL_BLOCKED_DOMAINS_SCOPE_KEY]: expectedScope,
      });
      assertCurrent('school block list persistence');
      globalBlockedDomains = normalized;
      globalBlockedDomainsStateTrusted = true;
      globalBlockedDomainsScope = expectedScope;
      return normalized;
    } catch (error) {
      if (isAuthContextCancellation(error)) {
        const activeScope = schoolPolicyScope();
        const activeDomains = globalBlockedDomainsStateTrusted
          && globalBlockedDomainsScope === activeScope
          ? globalBlockedDomains
          : [];
        await composeDynamicRules(['school'], { globalBlockedDomains: activeDomains }).catch(() => {});
      }
      throw error;
    }
  };
  const next = schoolPolicyMutation.catch(() => undefined).then(run);
  schoolPolicyMutation = next.catch(() => undefined);
  return next;
}

async function updateTeacherBlockListRules(blockedDomains) {
  const previous = teacherBlockedDomains;
  const normalized = RuntimeCore.normalizeDomainList(blockedDomains, 'teacher block list');
  teacherBlockedDomains = normalized;
  try {
    await composeDynamicRules(['teacher', 'restrictionSso']);
  } catch (error) {
    teacherBlockedDomains = previous;
    throw error;
  }
}

async function clearTeacherBlockListRules() {
  const previous = teacherBlockedDomains;
  teacherBlockedDomains = [];
  try {
    await composeDynamicRules(['teacher', 'restrictionSso']);
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
  const ranges = ['classroom', 'teacher', 'temporary', 'restrictionSso'];
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
    console.warn('Error getting logged-in user info:', safeDiagnosticError(error));
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
    console.log('[Service Worker] Chrome profile identity detected');
    
    // Extract name from email (e.g., john.smith@school.edu -> john.smith)
    const emailName = userInfo.email.split('@')[0];
    const displayName = emailName.replace(/\./g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    
    const normalizedEmail = normalizeEmail(userInfo.email);
    CONFIG.studentEmail = normalizedEmail;
    CONFIG.studentName = displayName;

    await setManualAuthState({
      studentEmail: normalizedEmail,
      studentName: displayName,
    });

    // Auto-register if not already registered or if the Chrome profile changed.
    const stored = await getStoredAuthState([
      'registered',
      'lastRegisteredEmail',
      'studentEmail',
      'identitySource',
    ]);
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
        console.log('[Service Worker] Chrome profile student registered');
      } catch (error) {
        console.warn('Auto-registration failed:', safeDiagnosticError(error));
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
      console.warn('[Auth] Failed to refresh registration after Chrome sign-in change:', safeDiagnosticError(error));
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
    console.log('[Service Worker] Device registration completed');
    
    // Save config (using deviceName as studentName for now)
    CONFIG.deviceId = deviceId;
    CONFIG.studentName = deviceName; // Display device name until teacher assigns student
    CONFIG.classId = classId;
    
    await chrome.storage.local.set({ config: persistedNonAuthConfig(CONFIG) });
    await setManualAuthState({
      registered: true,
      studentName: deviceName || null,
    });
    
    return data;
  } catch (error) {
    console.warn('Registration error:', safeDiagnosticError(error));
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
    console.log('[Service Worker] Student auto-registration completed');
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
    const authContextId = generateAuthContextId();
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
      const markerCleared = durableLocalKv.remove(STUDENT_AUTH_INVALIDATING_KEY);
      const durableStatePersisted = durableLocalKv.set({
        config: persistedConfig,
        autoRegistrationPaused: false,
      });
      await setManualAuthState({
        authContextId,
        registered: true,
        activeStudentId: studentId,
        activeStudentSessionId: studentSessionId,
        studentToken: data.studentToken,
        studentEmail,
        studentName,
        lastRegisteredEmail: studentEmail,
        identitySource: 'chrome_profile',
        manualLoginLastSeenAt: null,
      });
      await Promise.all([markerCleared, durableStatePersisted]);
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
      activateAuthenticatedContext(authContextId);
      const committedAuthContext = capturePendingAuthenticatedContext(
        'student auto-registration storage adoption',
        registrationGeneration,
      );
      await cleanupRetiredExactBoundStorage(
        committedAuthContext,
        'student auto-registration storage adoption',
      );
      adoptNegotiatedProtocolState(data, committedAuthContext);
      assertAuthMutationCurrent(registrationGeneration, 'student auto-registration');
      resetSharedSignInLoginConfigCache({ clearPersisted: true });
      await reconcileMessageInboxIdentity('student-registration', {
        authContext: committedAuthContext,
        expectedBinding: monitoringEventAuthBindingForContext(committedAuthContext),
      });
      await applyClassroomStateFromAuthResponse(
        data,
        'student_registration',
        {
          requireApplied: true,
          authContext: committedAuthContext,
          authMutationHeld: true,
        },
      );
      assertAuthMutationCurrent(registrationGeneration, 'student auto-registration');
      await completeStudentAuthCommit(
        registrationGeneration,
        'student auto-registration commit',
      );
      await replayClassroomUiForAuth(
        committedAuthContext,
        'student auto-registration UI replay',
      );
      await activateLicenseForAuthenticatedResponse(
        committedAuthContext,
        data.planStatus,
        { notify: false },
      );
      if (trackingState !== TRACKING_STATES.OFF) connectWebSocket().catch(() => {});
    });
    
    // Start adaptive tracking after registration
    initializeAdaptiveTracking('student-registered');
    checkLicenseStatus('student-registered').catch(() => {});
    
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
        warnAuthCleanupFailure(
          '[Auth] Failed student auto-registration commit cleanup:',
          cleanupError,
        );
      }
    }
    console.warn('Student registration error:', safeDiagnosticError(error));
    throw error;
  }
}

async function invalidateStudentTokenFromHeartbeat(authContext, reason, options = {}) {
  assertAuthenticatedContextCurrent(authContext, `heartbeat:${reason}:token-clear`);
  await clearStudentAuth('student-token-invalid', {
    notifyBackend: false,
    pauseAutoRegistration: false,
    expectedAuthContext: authContext,
  });
  if (options.scheduleRegistration === false) return;
  registrationRetryCount++;
  if (registrationRetryCount <= MAX_REGISTRATION_RETRIES) {
    const backoff = Math.min(5000 * Math.pow(2, registrationRetryCount - 1), 300000);
    setTimeout(() => ensureRegistered().catch(() => {}), backoff);
  }
}

// Send heartbeat with current tab info
async function sendHeartbeat(reason = 'manual') {
  await classroomStateRestorePromise;
  if (!currentLicenseIsActive()) {
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
  let heartbeatAuthContext;
  try {
    heartbeatAuthContext = captureAuthenticatedContext(`heartbeat:${reason}`);
  } catch (error) {
    if (isAuthContextCancellation(error)) return;
    if (isAuthContextCancellation(error)) {
      console.info(`[Heartbeat] Skipping ${reason}; authentication context is not ready`);
      return;
    }
    throw error;
  }

  let heartbeatRequestStarted = false;
  let heartbeatResponseReceived = false;
  let heartbeatRequestTimedOut = false;
  const protocolPolicyGeneration = reserveProtocolPolicyRequestGeneration();
  const heartbeatScreenshotPolicyGeneration = reserveScreenshotPolicyRequestGeneration();

  try {
    // Get the active tab from the LAST FOCUSED window (the one the user is actually looking at)
    // Service workers don't have a "current window", so we must query for lastFocusedWindow
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:active-tab`);

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
    
    // Collect ALL open tabs for teacher dashboard
    // Use caching to prevent flickering when chrome.tabs.query returns inconsistent results
    let allOpenTabs = [];
    let tabSnapshotRevision = currentTabSnapshotRevision;
    try {
      const allTabs = await chrome.tabs.query({});
      assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:all-tabs`);
      const httpTabs = allTabs.filter(tab => tab.url && tab.url.startsWith('http'));
      const tabSnapshot = await buildOpaqueTabSnapshot(httpTabs, heartbeatAuthContext);
      assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:tab-snapshot`);
      allOpenTabs = tabSnapshot.tabs;
      tabSnapshotRevision = tabSnapshot.revision;
      activeTabRef = tabSnapshot.localEntries.find((entry) => entry.tabId === activeTabId)?.tabRef || null;
      lastKnownTabs = allOpenTabs;
      lastKnownTabsAuthBinding = monitoringEventAuthBindingForContext(heartbeatAuthContext);
    } catch (error) {
      console.warn('[Heartbeat] Failed to collect tabs:', safeDiagnosticError(error));
      // Use cached tabs on error to prevent flickering
      if (
        lastKnownTabs.length > 0
        && lastKnownTabsAuthBinding === monitoringEventAuthBindingForContext(heartbeatAuthContext)
      ) {
        allOpenTabs = lastKnownTabs;
        console.log(`[Heartbeat] Using cached ${lastKnownTabs.length} tabs after error`);
      }
    }
    
    // Send heartbeat even without active tab (keeps student "online")
    // Server will display "No active tab" when title/URL are empty strings
    const heartbeatClassroomAckIsCurrent = lastClassroomStateAckAuthBinding
      === monitoringEventAuthBindingForContext(heartbeatAuthContext);
    const heartbeatData = {
      studentEmail: heartbeatAuthContext.studentEmail, // JWT is the authority for manual shared-device login
      deviceId: heartbeatAuthContext.deviceId,         // Internal device tracking
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
      appliedClassroomStateRevision: heartbeatClassroomAckIsCurrent
        ? lastClassroomStateAckRevision
        : 0,
      classroomStateOutcome: heartbeatClassroomAckIsCurrent
        ? lastClassroomStateOutcome
        : 'pending',
      classroomStateSessionId: currentClassroomState?.teachingSessionId || undefined,
      classroomStateSupervisionContextId: currentClassroomState?.supervisionContextId || undefined,
      requestClassroomState: requestClassroomStateOnHeartbeat(),
      fabStateRevision: currentFabState?.revision ?? 0,
      requestFabState: requestFabStateOnHeartbeat(),
      // Screenshot health diagnostics (helps dashboard show why screenshots may be missing)
      screenshotHealth: {
        lastSuccessfulHeartbeatAt: Number(connectivityHealth.lastSuccessAt || 0),
        screenshotPolicySource,
        screenshotPolicyAdoptedAt,
        lastCaptureAttemptAt: lastScreenshotAttemptAt,
        lastAttemptAt: lastScreenshotAttemptAt,
        lastSuccessAt: lastScreenshotSuccessAt,
        lastErrorAt: lastScreenshotErrorAt,
        lastError: lastScreenshotError,
        lastErrorCode: lastScreenshotError,
        attempts: screenshotAttemptCount,
        successes: screenshotSuccessCount,
        alarmActive: screenshotScheduled,
        captureState: ambientScreenshotAllowed(heartbeatAuthContext)
          ? 'active'
          : 'paused_unobserved',
      },
    };
    
    const headers = buildDeviceAuthHeaders(heartbeatAuthContext);
    const heartbeatMessageBinding = messageInboxAuthBinding();
    const heartbeatAuthResponseGuard = captureAuthenticatedResponseGuard();
    attachLegacyStudentToken(heartbeatData, headers, heartbeatAuthContext);
    if (headers.Authorization) {
      console.log('Sending JWT-authenticated heartbeat');
    } else {
      console.log('⚠️  Sending legacy heartbeat (no JWT)');
    }

    assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:send`);
    heartbeatRequestStarted = true;
    const heartbeatRequestStartedAt = Date.now();
    const heartbeatRequestController = new AbortController();
    const abortHeartbeatForAuth = () => heartbeatRequestController.abort();
    heartbeatAuthContext.signal.addEventListener('abort', abortHeartbeatForAuth, { once: true });
    const heartbeatTimeoutId = setTimeout(() => {
      heartbeatRequestTimedOut = true;
      heartbeatRequestController.abort();
    }, HEARTBEAT_REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetchWithBackoff(`${heartbeatAuthContext.serverOrigin}/api/device/heartbeat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(heartbeatData),
        signal: heartbeatRequestController.signal,
      }, {
        context: 'device heartbeat',
        maxAttempts: 2,
      });
    } finally {
      clearTimeout(heartbeatTimeoutId);
      heartbeatAuthContext.signal.removeEventListener('abort', abortHeartbeatForAuth);
    }
    const heartbeatResponseReceivedAt = Date.now();
    heartbeatResponseReceived = true;
    assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:response`);

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
        scheduleEventHeartbeat('identity-changed-reconcile');
      }
      return;
    }

    if (response.status === 402) {
      const data = await response.json().catch(() => ({}));
      assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:license-body`);
      await disableForInactiveLicense(data.planStatus, heartbeatAuthContext);
      return;
    } else if (response.status === 409) {
      const data = await response.json().catch(() => ({}));
      assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:conflict-body`);
      if (data?.error === 'student_session_replaced') {
        console.warn('[Auth] Student session was replaced on another Chromebook');
        await clearStudentAuth('session-replaced', {
          notifyBackend: false,
          serverSessionEnded: true,
          pauseAutoRegistration: true,
          expectedAuthContext: heartbeatAuthContext,
        });
        return;
      }
      console.warn('Heartbeat conflict:', response.status);
      return;
    } else if (response.status === 401 || response.status === 403) {
      const data = await response.json().catch(() => ({}));
      assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:authorization-body`);
      if (isClassPilotNotEntitledResponse(data)) {
        await disableForInactiveLicense(data.planStatus, heartbeatAuthContext);
        return;
      }
      if (isManualIdentitySource()) {
        // A bare HTTP authorization denial proves that this bearer can no
        // longer be used, but it does not prove that the exact manual session
        // row has ended. Preserve/promote its recovery capability so the gate
        // can release or reclaim that same-Chromebook session. Exact
        // replacement/sign-out messages use their correlated tombstone paths
        // and are the only paths that discard recovery as already ended.
        await clearStudentAuth('manual-token-invalid', {
          notifyBackend: false,
          serverSessionEnded: false,
          pauseAutoRegistration: true,
          preserveRecoveryForGate: true,
          expectedAuthContext: heartbeatAuthContext,
        });
        return;
      }
      // ✅ JWT INVALID/EXPIRED: Token expired (401) or invalid (403) - need to re-register
      console.warn(`❌ [JWT] Token ${response.status === 401 ? 'expired' : 'invalid'} (${response.status}) - clearing token and re-registering`);
      await invalidateStudentTokenFromHeartbeat(heartbeatAuthContext, reason);
      return; // Skip rest of error handling
    } else if (response.status === 408 || response.status >= 500) {
      await recordHeartbeatFailure('server_unavailable', Date.now(), heartbeatAuthContext);
      console.warn('Heartbeat server responded:', response.status);
    } else if (response.ok) {
      await recordHeartbeatSuccess(Date.now(), heartbeatAuthContext);
      if (isManualIdentitySource()) {
        assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:manual-last-seen`);
        CONFIG.manualLoginLastSeenAt = Date.now();
        await setManualAuthState({ manualLoginLastSeenAt: CONFIG.manualLoginLastSeenAt });
        assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:manual-last-seen`);
      }
      // Check for pending messages missed during WebSocket disconnection
      try {
        const data = await response.json();
        assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:response-body`);
        await adoptAuthenticatedStudentBinding(
          data,
          'heartbeat response',
          heartbeatAuthResponseGuard,
        );
        assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:binding-adoption`);
        adoptProtocolAndScreenshotPolicy(data, heartbeatAuthContext, {
          requestGeneration: protocolPolicyGeneration,
          screenshotRequestGeneration: heartbeatScreenshotPolicyGeneration,
          requestStartedAt: heartbeatRequestStartedAt,
          responseReceivedAt: heartbeatResponseReceivedAt,
          policySource: 'heartbeat',
        });
        await applyClassroomStateFromAuthResponse(data, 'heartbeat_reconcile');
        assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:classroom-state`);
        if (Object.prototype.hasOwnProperty.call(data, 'fab')) {
          await applyFabSettings(data.fab || {}, {
            reason: 'heartbeat-reconcile',
            broadcast: true,
          });
          assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:fab-state`);
        }
        if (Array.isArray(data.pendingMessages) && data.pendingMessages.length > 0) {
          const inboxResult = await handleHeartbeatPendingMessages(
            data.pendingMessages,
            heartbeatMessageBinding,
            heartbeatAuthContext,
          );
          assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:pending-messages`);
          if (inboxResult.addedMessageIds.length > 0) {
            console.log('[Heartbeat] Stored new pending messages:', inboxResult.addedMessageIds.length);
          }
        }
      } catch (error) {
        if (isAuthContextCancellation(error)) throw error;
        // Compatibility: a legacy success response may have no JSON body.
      }
    } else {
      // Client error (400s) - log but don't retry
      console.warn('Heartbeat client error:', response.status);
    }
    
  } catch (error) {
    if (isAuthContextCancellation(error) && !heartbeatRequestTimedOut) {
      console.info(`[Heartbeat] Discarded ${reason} work for a retired authentication context`);
      if (hasStudentAuth()) {
        scheduleEventHeartbeat('identity-changed-reconcile');
      }
      return;
    }
    if (heartbeatRequestStarted && !heartbeatResponseReceived) {
      await recordHeartbeatFailure('network_error', Date.now(), heartbeatAuthContext).catch(() => {});
    }
    // This means only that the school server could not be reached. It is not
    // evidence that Wi-Fi was intentionally disabled or that a student acted.
    console.warn('Heartbeat network issue:', safeDiagnosticError(error));
  }
}

// Health check: refreshes tracking state after service worker restarts
async function healthCheck() {
  console.log('[Health Check] Running...');
  await flushStudentSessionRecovery({ maxRecords: 1 }).catch(() => {});
  if (!CONFIG.deviceId) {
    console.log('[Health Check] No deviceId - extension not yet configured');
    return;
  }
  if (!hasStudentAuth()) {
    // Configured signed-out devices perform only local gate maintenance on a
    // five-minute cadence. School settings require a student token.
    scheduleHealthCheckAlarm(5);
    await updateTrackingState('health-check-signed-out');
    return;
  }
  scheduleHealthCheckAlarm(1);
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

async function handleLicenseControlCleanupAlarm() {
  let authContext;
  try {
    authContext = captureAuthenticatedContext('license control cleanup alarm');
  } catch (error) {
    await chrome.alarms.clear(LICENSE_CONTROL_CLEANUP_ALARM).catch(() => false);
    return;
  }
  const expectedScope = licenseScopeForAuthContext(authContext);
  if (!expectedScope) {
    await chrome.alarms.clear(LICENSE_CONTROL_CLEANUP_ALARM).catch(() => false);
    return;
  }

  try {
    const stored = await kv.get([
      'licenseActive',
      'planStatus',
      LICENSE_STATE_SCOPE_KEY,
    ]);
    assertAuthenticatedContextCurrent(authContext, 'license control cleanup alarm');
    if (
      stored.licenseActive !== false
      || stored[LICENSE_STATE_SCOPE_KEY] !== expectedScope
    ) {
      await chrome.alarms.clear(LICENSE_CONTROL_CLEANUP_ALARM).catch(() => false);
      return;
    }
    await disableForInactiveLicense(stored.planStatus, authContext);
    assertAuthenticatedContextCurrent(authContext, 'license control cleanup alarm');
  } catch (error) {
    if (isAuthContextCancellation(error) || error?.code === 'AUTH_MUTATION_SUPERSEDED') {
      await chrome.alarms.clear(LICENSE_CONTROL_CLEANUP_ALARM).catch(() => false);
      return;
    }
    try {
      assertAuthenticatedContextCurrent(authContext, 'license control cleanup alarm retry');
      const stored = await kv.get(['licenseActive', LICENSE_STATE_SCOPE_KEY]);
      assertAuthenticatedContextCurrent(authContext, 'license control cleanup alarm retry');
      if (
        stored.licenseActive === false
        && stored[LICENSE_STATE_SCOPE_KEY] === expectedScope
      ) {
        chrome.alarms.create(LICENSE_CONTROL_CLEANUP_ALARM, {
          when: Date.now() + LICENSE_CONTROL_CLEANUP_RETRY_MS,
        });
      } else {
        await chrome.alarms.clear(LICENSE_CONTROL_CLEANUP_ALARM).catch(() => false);
      }
    } catch {
      await chrome.alarms.clear(LICENSE_CONTROL_CLEANUP_ALARM).catch(() => false);
    }
  }
}

function handleScreenshotLeaseExpiryAlarm(alarm = {}, nowValue = Date.now()) {
  if (
    !['lease', 'tracking_window_lease'].includes(screenshotPolicyState.mode)
    || screenshotPolicyState.valid !== true
  ) return false;
  const expiresAt = Number(screenshotPolicyState.expiresAt || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
  if (expiresAt > nowValue) {
    // Chrome may already have queued the prior alarm when a heartbeat or WS
    // response renews/replaces the lease. The current exact policy is the
    // authority; preserve it and schedule its own deadline.
    chrome.alarms.create(SCREENSHOT_LEASE_EXPIRY_ALARM, { when: expiresAt });
    return false;
  }
  advanceScreenshotPolicyAuthority();
  screenshotImmediateCapturePending = false;
  screenshotPolicyState = Object.freeze({
    ...screenshotPolicyState,
    observed: false,
    captureAllowed: false,
    expiresAt: 0,
    captureCadence: backgroundScreenshotCaptureCadence(),
  });
  scheduleScreenshotCapture(false);
  return true;
}

// Alarm listener for heartbeat and WebSocket reconnection
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat') {
    handleHeartbeatRecoveryAlarm();
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
  } else if (alarm.name === LICENSE_CHECK_ALARM) {
    checkLicenseStatus('alarm').catch(() => {});
  } else if (alarm.name === LICENSE_STATUS_RETRY_ALARM) {
    checkLicenseStatus('retry-alarm').catch(() => {});
  } else if (alarm.name === LICENSE_CONTROL_CLEANUP_ALARM) {
    handleLicenseControlCleanupAlarm().catch(() => {});
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
  } else if (alarm.name === STUDENT_SESSION_RECOVERY_ALARM) {
    // Keep alarm cleanup bounded to the same single-record unit used by gate
    // preparation. If a worker wake and the login gate coalesce on the shared
    // flush promise, an old queue must never hold the roster behind eight
    // sequential network requests.
    flushStudentSessionRecovery({ maxRecords: 1 }).catch(() => {});
  } else if (alarm.name === CLASSROOM_STATE_EXPIRY_ALARM) {
    classroomStateRestorePromise.then(() => checkClassroomStateExpiry()).catch((error) => {
      console.warn('[Classroom State] Expiry check failed:', safeDiagnosticError(error));
    });
  } else if (alarm.name === CLASSROOM_STATE_RECONCILE_ALARM) {
    handleClassroomStateReconcileAlarm().catch((error) => {
      if (isAuthContextCancellation(error)) return;
      console.warn('[Classroom State] Reconciliation retry failed:', safeDiagnosticError(error));
      scheduleClassroomStateReconciliationRetry();
    });
  } else if (alarm.name === MONITORING_EVENT_FLUSH_ALARM) {
    flushMonitoringEventOutbox().catch(() => {});
  } else if (alarm.name === COMMAND_ACK_FLUSH_ALARM) {
    compactCommandAckStorageOnly()
      .then(() => flushCommandAckOutbox({ forceHttp: true }))
      .catch(() => {});
  } else if (alarm.name === CHAT_ACK_FLUSH_ALARM) {
    compactChatAckStorageOnly()
      .then(() => flushChatAckOutbox({ forceHttp: true }))
      .catch(() => {});
  } else if (alarm.name === STUDENT_CHAT_FLUSH_ALARM) {
    compactStudentChatStorageOnly()
      .then(() => flushStudentChatOutbox())
      .catch(() => {});
  } else if (alarm.name === AUTH_BOUND_NOTIFICATION_CLEANUP_ALARM) {
    handleAuthBoundNotificationCleanupAlarm().catch(() => {});
  } else if (alarm.name === PENDING_CHECK_IN_EXPIRY_ALARM) {
    expirePendingCheckIn(alarm).catch(() => {});
  } else if (alarm.name === CLASSROOM_OVERLAY_EXPIRY_ALARM) {
    expireClassroomOverlays().catch(() => {});
  } else if (alarm.name === 'screenshot-capture') {
    captureAndSendScreenshot({ reason: 'alarm' });
  } else if (alarm.name === SCREENSHOT_ACTIVE_CADENCE_EXPIRY_ALARM) {
    expireActiveScreenshotCadence('active-view-expired');
  } else if (alarm.name === SCREENSHOT_LEASE_EXPIRY_ALARM) {
    handleScreenshotLeaseExpiryAlarm(alarm);
  }
});

// Screenshot Thumbnail Capture (for teacher dashboard grid view)
// Uses chrome.alarms (30s minimum) instead of setInterval so it survives
// MV3 service worker termination. setInterval dies when the SW goes inactive.
const SCREENSHOT_ALARM_NAME = 'screenshot-capture';
const SCREENSHOT_LEASE_EXPIRY_ALARM = 'screenshot-observation-lease-expiry';
const SCREENSHOT_ACTIVE_CADENCE_EXPIRY_ALARM = 'screenshot-active-view-cadence-expiry';
const SCREENSHOT_PERIOD_MS = 30 * 1000;
const SCREENSHOT_SCHEDULED_MIN_GAP_MS = 25 * 1000;
const SCREENSHOT_ACTIVE_CADENCE_INTERVAL_MS = 5 * 1000;
const SCREENSHOT_ACTIVE_CADENCE_MIN_GAP_MS = 4500;
const SCREENSHOT_ACTIVE_NAVIGATION_MIN_GAP_MS = SCREENSHOT_ACTIVE_CADENCE_MIN_GAP_MS;
const SCREENSHOT_ACTIVE_NAVIGATION_DEBOUNCE_MS = 750;
const SCREENSHOT_COMMAND_MIN_GAP_MS = 5 * 1000;
let screenshotScheduled = false;

function scheduleScreenshotCapture(enable) {
  if (enable) {
    let authContext = null;
    try {
      authContext = captureAuthenticatedContext('screenshot scheduling');
    } catch {
      authContext = null;
    }
    if (!authContext || !ambientScreenshotAllowed(authContext)) {
      screenshotScheduled = false;
      chrome.alarms.clear(SCREENSHOT_ALARM_NAME);
      return;
    }
  }
  if (enable && !screenshotScheduled) {
    screenshotScheduled = true;
    // chrome.alarms minimum is 30 seconds; use 0.5 min (30s) for near-real-time
    chrome.alarms.create(SCREENSHOT_ALARM_NAME, { periodInMinutes: 0.5 });
    console.log('[Screenshot] Scheduled periodic capture via chrome.alarms (every 30s)');
  } else if (!enable && screenshotScheduled) {
    screenshotScheduled = false;
    chrome.alarms.clear(SCREENSHOT_ALARM_NAME);
    console.log('[Screenshot] Stopped periodic capture');
  }
}

function subscribeTabActivationFence(expectedTab, onChanged, override = null) {
  if (typeof override === 'function') return override(onChanged);
  if (!chrome.tabs?.onActivated?.addListener) return () => {};
  const listener = (activeInfo) => {
    if (
      activeInfo?.windowId === expectedTab.windowId
      && activeInfo?.tabId !== expectedTab.id
    ) onChanged(activeInfo);
  };
  chrome.tabs.onActivated.addListener(listener);
  return () => chrome.tabs.onActivated.removeListener(listener);
}

function subscribeTabNavigationFence(expectedTab, onChanged, override = null) {
  if (typeof override === 'function') return override(onChanged);
  if (!chrome.tabs?.onUpdated?.addListener) return () => {};
  const listener = (tabId, changeInfo = {}, updatedTab = null) => {
    if (tabId !== expectedTab.id) return;
    const changedUrl = String(changeInfo.url || updatedTab?.pendingUrl || '').trim();
    if (
      changeInfo.status === 'loading'
      || (changedUrl && changedUrl !== expectedTab.url)
    ) onChanged(changeInfo);
  };
  chrome.tabs.onUpdated.addListener(listener);
  return () => chrome.tabs.onUpdated.removeListener(listener);
}

function subscribeWindowFocusFence(expectedTab, onChanged, override = null) {
  if (typeof override === 'function') return override(onChanged);
  if (!chrome.windows?.onFocusChanged?.addListener) return () => {};
  const listener = (windowId) => {
    if (windowId !== expectedTab.windowId) onChanged(windowId);
  };
  chrome.windows.onFocusChanged.addListener(listener);
  return () => chrome.windows.onFocusChanged.removeListener(listener);
}

function isSameActiveCaptureTab(candidate, expected) {
  return Boolean(
    candidate
    && Number.isInteger(expected?.id)
    && candidate.id === expected.id
    && candidate.windowId === expected.windowId
    && candidate.active === true
    && String(candidate.url || '') === String(expected.url || '')
  );
}

function screenshotCaptureMinimumGap(reason) {
  if (['lease-start', 'authority-change'].includes(reason)) return 0;
  if (reason === 'active-view-tick') return SCREENSHOT_ACTIVE_CADENCE_MIN_GAP_MS;
  if (reason === 'active-view-navigation') return SCREENSHOT_ACTIVE_NAVIGATION_MIN_GAP_MS;
  if (reason === 'command') return SCREENSHOT_COMMAND_MIN_GAP_MS;
  return SCREENSHOT_SCHEDULED_MIN_GAP_MS;
}

async function captureAndSendScreenshot(options = {}) {
  const reason = options.reason || 'scheduled';
  const rapidCapture = reason === 'active-view-tick' || reason === 'active-view-navigation';
  const minimumGap = screenshotCaptureMinimumGap(reason);
  if (lastScreenshotAttemptAt && Date.now() - lastScreenshotAttemptAt < minimumGap) {
    console.log(`[Screenshot] Coalescing ${reason} capture; cadence guard active`);
    return;
  }
  if (screenshotCaptureInFlight) {
    console.log('[Screenshot] Skipping capture; previous capture still in flight');
    return;
  }
  if (!currentLicenseIsActive() || trackingState === TRACKING_STATES.OFF) {
    return;
  }
  if (await expireManualAuthIfStale('screenshot-capture')) {
    return;
  }
  if (!hasStudentAuth()) {
    scheduleHealthCheckAlarm(5);
    await notifyAuthGateStateToTabs();
    return;
  }
  let screenshotAuthContext;
  try {
    screenshotAuthContext = captureAuthenticatedContext(`screenshot:${reason}`);
  } catch (error) {
    if (isAuthContextCancellation(error)) {
      console.info(`[Screenshot] Skipping ${reason}; authentication context is not ready`);
      return;
    }
    throw error;
  }
  if (!ambientScreenshotAllowed(screenshotAuthContext)) {
    // This is an expected privacy state, not an operational failure.
    return { status: 'paused_unobserved' };
  }
  const capturePolicyGeneration = screenshotPolicyGeneration;
  const captureScreenshotAuthority = screenshotPolicyState.authority;
  const captureAuthorityScope = screenshotPolicyState.authorityScope || null;
  const capturePolicySignal = screenshotPolicyAbortController.signal;
  const captureRequestAbortController = new AbortController();
  const abortCaptureRequest = () => captureRequestAbortController.abort();
  screenshotAuthContext.signal.addEventListener('abort', abortCaptureRequest, { once: true });
  capturePolicySignal.addEventListener('abort', abortCaptureRequest, { once: true });
  if (screenshotAuthContext.signal.aborted || capturePolicySignal.aborted) {
    abortCaptureRequest();
  }
  screenshotCaptureInFlight = true;
  let screenshotPhase = 'capture';
  try {
    await recordScreenshotAttempt(Date.now(), screenshotAuthContext);
    assertAmbientScreenshotPolicyCurrent(
      screenshotAuthContext,
      capturePolicyGeneration,
      captureAuthorityScope,
      `screenshot:${reason}:attempt`,
    );
    screenshotAttemptCount++;
    if (Date.now() < apiBackoffUntilMs) {
      await recordScreenshotError('rate_limited_backoff', Date.now(), screenshotAuthContext);
      console.log('[Screenshot] Skipping capture during API backoff');
      return;
    }

    // Get the last focused window
    const queryActiveTab = options.queryActiveTab
      || ((queryInfo) => chrome.tabs.query(queryInfo));
    const captureVisibleTab = options.captureVisibleTab
      || ((windowId, captureOptions) => chrome.tabs.captureVisibleTab(windowId, captureOptions));
    const [tab] = await queryActiveTab({ active: true, lastFocusedWindow: true });
    assertAuthenticatedContextCurrent(screenshotAuthContext, `screenshot:${reason}:active-tab`);
    assertAmbientScreenshotPolicyCurrent(
      screenshotAuthContext,
      capturePolicyGeneration,
      captureAuthorityScope,
      `screenshot:${reason}:active-tab`,
    );
    if (!tab || !tab.windowId) {
      await recordScreenshotError('no_active_tab', Date.now(), screenshotAuthContext);
      console.log('[Screenshot] No active tab in focused window');
      return;
    }

    // Skip chrome:// and other non-HTTP pages
    if (!tab.url || !tab.url.startsWith('http')) {
      await recordScreenshotError('non_http_page', Date.now(), screenshotAuthContext);
      console.log('[Screenshot] Skipping non-HTTP page');
      return;
    }

    let activationChanged = false;
    const unsubscribeActivation = subscribeTabActivationFence(
      tab,
      () => { activationChanged = true; },
      options.subscribeTabActivation,
    );
    const unsubscribeNavigation = subscribeTabNavigationFence(
      tab,
      () => { activationChanged = true; },
      options.subscribeTabUpdate,
    );
    const unsubscribeWindowFocus = subscribeWindowFocusFence(
      tab,
      () => { activationChanged = true; },
      options.subscribeWindowFocus,
    );
    let dataUrl;
    let capturedAt;
    try {
      const [beforeCaptureTab] = await queryActiveTab({ active: true, lastFocusedWindow: true });
      assertAuthenticatedContextCurrent(screenshotAuthContext, `screenshot:${reason}:pre-capture-tab`);
      assertAmbientScreenshotPolicyCurrent(
        screenshotAuthContext,
        capturePolicyGeneration,
        captureAuthorityScope,
        `screenshot:${reason}:pre-capture-tab`,
      );
      if (activationChanged || !isSameActiveCaptureTab(beforeCaptureTab, tab)) {
        await recordScreenshotError('active_tab_changed', Date.now(), screenshotAuthContext);
        return { status: 'unavailable', reason: 'active_tab_changed' };
      }
      // captureVisibleTab is window-scoped rather than tab-scoped. Fence every
      // activation in that window and confirm the exact tab on both sides.
      dataUrl = await captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality: 50  // Lower quality for smaller file size (~30-50KB)
      });
      // Fix the pixel acquisition time immediately. Retries reuse this value;
      // upload time must never relabel old pixels as a newer authority sample.
      capturedAt = new Date().toISOString();
      assertAuthenticatedContextCurrent(screenshotAuthContext, `screenshot:${reason}:captured-pixels`);
      assertAmbientScreenshotPolicyCurrent(
        screenshotAuthContext,
        capturePolicyGeneration,
        captureAuthorityScope,
        `screenshot:${reason}:captured-pixels`,
      );
      const [afterCaptureTab] = await queryActiveTab({ active: true, lastFocusedWindow: true });
      assertAuthenticatedContextCurrent(screenshotAuthContext, `screenshot:${reason}:post-capture-tab`);
      assertAmbientScreenshotPolicyCurrent(
        screenshotAuthContext,
        capturePolicyGeneration,
        captureAuthorityScope,
        `screenshot:${reason}:post-capture-tab`,
      );
      if (activationChanged || !isSameActiveCaptureTab(afterCaptureTab, tab)) {
        await recordScreenshotError('active_tab_changed', Date.now(), screenshotAuthContext);
        return { status: 'unavailable', reason: 'active_tab_changed' };
      }
    } finally {
      unsubscribeActivation?.();
      unsubscribeNavigation?.();
      unsubscribeWindowFocus?.();
    }

    if (!dataUrl) {
      await recordScreenshotError('capture_empty', Date.now(), screenshotAuthContext);
      console.log('[Screenshot] Capture returned empty');
      return;
    }

    // Send screenshot to server with tab metadata
    screenshotPhase = 'upload';
    const headers = buildDeviceAuthHeaders(screenshotAuthContext);
    assertAuthenticatedContextCurrent(screenshotAuthContext, `screenshot:${reason}:upload`);
    assertAmbientScreenshotPolicyCurrent(
      screenshotAuthContext,
      capturePolicyGeneration,
      captureAuthorityScope,
      `screenshot:${reason}:upload`,
    );
    const trackingWindowLeaseNegotiated = hasNegotiatedCapability(
      'screenshotTrackingWindowLeaseV1',
      screenshotAuthContext,
    );
    const screenshotUploadPath = (
      trackingWindowLeaseNegotiated
      || hasNegotiatedCapability('screenshotObservationLeaseV1', screenshotAuthContext)
    )
      ? '/api/classpilot/device/screenshot'
      : '/api/device/screenshot';
    const screenshotUploadStartedAt = Date.now();
    const screenshotUploadPolicyGeneration = reserveScreenshotPolicyRequestGeneration();
    const response = await fetchWithBackoff(`${screenshotAuthContext.serverOrigin}${screenshotUploadPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...extensionProtocolDescriptor(),
        screenshot: dataUrl,  // base64 data URL
        capturedAt,
        timestamp: Date.parse(capturedAt),
        ...(trackingWindowLeaseNegotiated
          ? { screenshotAuthority: captureScreenshotAuthority }
          : { deviceId: screenshotAuthContext.deviceId }),
        tabTitle: tab.title || '',
        tabUrl: tab.url || '',
        tabFavicon: tab.favIconUrl || '',
      }),
      signal: captureRequestAbortController.signal,
    }, {
      context: 'screenshot upload',
      // Rapid captures already receive another bounded cadence opportunity.
      // Retrying the same pixels would amplify a store outage or rate limit.
      maxAttempts: rapidCapture ? 1 : 2,
      beforeAttempt: () => assertAmbientScreenshotPolicyCurrent(
        screenshotAuthContext,
        capturePolicyGeneration,
        captureAuthorityScope,
        `screenshot:${reason}:upload-attempt`,
      ),
    });
    assertAuthenticatedContextCurrent(screenshotAuthContext, `screenshot:${reason}:upload-response`);
    const responseReceivedAt = Date.now();
    const responseBody = await response.json().catch(() => ({}));
    if (response.status === 402 || (
      response.status === 403
      && isClassPilotNotEntitledResponse(responseBody)
    )) {
      await disableForInactiveLicense(responseBody.planStatus, screenshotAuthContext);
      return { status: 'paused_unobserved', reason: 'license_denied' };
    }
    if (response.status === 401 || response.status === 403) {
      if (isManualIdentitySource()) {
        // Screenshot authorization is not an exact session tombstone. Keep
        // recovery durable while retiring the unusable bearer so the same
        // Chromebook can immediately offer resume/switch at the login gate.
        await clearStudentAuth('manual-token-invalid', {
          notifyBackend: false,
          serverSessionEnded: false,
          pauseAutoRegistration: true,
          preserveRecoveryForGate: true,
          expectedAuthContext: screenshotAuthContext,
        });
      } else {
        await invalidateStudentTokenFromHeartbeat(
          screenshotAuthContext,
          `screenshot:${reason}`,
        );
      }
      return { status: 'paused_unobserved', reason: 'authorization_denied' };
    }
    const structuredAuthorityDenial = typeof responseBody?.code === 'string'
      && /(?:AUTH|BINDING|SESSION|UNAUTHORIZED|FORBIDDEN)/.test(responseBody.code);
    const heartbeatRequired = responseBody?.code === 'SCREENSHOT_CAPABILITY_HEARTBEAT_REQUIRED';
    // Denials are applied against the immutable capture authority. A late A
    // response may install an explicit current-B policy returned by the
    // server, but an unscoped or A-scoped denial cannot revoke B.
    if (!response.ok && (
      responseBody?.code === 'SCREENSHOT_PAUSED_UNOBSERVED'
      || response.status === 404
      || (response.status === 409 && !heartbeatRequired)
      || structuredAuthorityDenial
    )) {
      applyServerScreenshotPolicyDenial(responseBody.screenshotPolicy, screenshotAuthContext, {
        requestStartedAt: screenshotUploadStartedAt,
        responseReceivedAt,
        capturedAuthorityScope: captureAuthorityScope,
      });
      const pausedUnobserved = responseBody?.code === 'SCREENSHOT_PAUSED_UNOBSERVED';
      await recordScreenshotError(
        pausedUnobserved ? 'paused_unobserved' : 'authorization_denied',
        responseReceivedAt,
        screenshotAuthContext,
      );
      scheduleEventHeartbeat(
        pausedUnobserved ? 'screenshot-paused-unobserved' : 'screenshot-authorization-denied',
      );
      return {
        status: 'paused_unobserved',
        ...(pausedUnobserved ? {} : { reason: 'authorization_denied' }),
      };
    }
    assertAmbientScreenshotPolicyCurrent(
      screenshotAuthContext,
      capturePolicyGeneration,
      captureAuthorityScope,
      `screenshot:${reason}:upload-response`,
    );

    if (!response.ok) {
      if (heartbeatRequired) {
        await recordScreenshotError('heartbeat_required', Date.now(), screenshotAuthContext);
        // Coalesce concurrent capture failures into one near-immediate
        // heartbeat. The steady-state 10-second cadence remains unchanged.
        scheduleEventHeartbeat('screenshot-capability-heartbeat-required');
        return { status: 'retrying', reason: 'heartbeat_required' };
      }
      if (response.status === 503) {
        await recordScreenshotError('upload_service_unavailable', Date.now(), screenshotAuthContext);
        // A transient store outage is not a screenshot-policy decision. Keep
        // the still-valid exact-scope lease and let the bounded request retry
        // plus the 30-second background capture cadence recover naturally.
        return { status: 'unavailable', reason: 'service_unavailable' };
      }
      await recordScreenshotError(response.status >= 500
        ? 'upload_server_error'
        : 'upload_client_error', Date.now(), screenshotAuthContext);
      console.warn('[Screenshot] Upload failed:', response.status);
    } else {
      if (trackingWindowLeaseNegotiated && responseBody.screenshotPolicy) {
        applySuccessfulScreenshotUploadPolicy(
          responseBody.screenshotPolicy,
          screenshotAuthContext,
          {
            screenshotRequestGeneration: screenshotUploadPolicyGeneration,
            requestStartedAt: screenshotUploadStartedAt,
            responseReceivedAt,
            capturedAuthorityScope: captureAuthorityScope,
          },
        );
      }
      await recordScreenshotSuccess(Date.now(), screenshotAuthContext);
      screenshotSuccessCount++;
      console.log('[Screenshot] Uploaded successfully');
    }
  } catch (error) {
    if (
      capturePolicySignal.aborted
      || screenshotPolicyGeneration !== capturePolicyGeneration
      || (screenshotPolicyState.authorityScope || null) !== captureAuthorityScope
    ) {
      console.info('[Screenshot] Discarded capture after screenshot authority changed');
      return { status: 'paused_unobserved' };
    }
    if (isAuthContextCancellation(error)) {
      console.info(`[Screenshot] Discarded ${reason} capture for a retired authentication context`);
      return;
    }
    if (error?.code === 'SCREENSHOT_PAUSED_UNOBSERVED') {
      console.info('[Screenshot] Capture paused because no current screenshot lease is active');
      return { status: 'paused_unobserved' };
    }
    if (error?.code === 'SCREENSHOT_POLICY_SUPERSEDED') {
      console.info('[Screenshot] Discarded capture after screenshot authority changed');
      return { status: 'paused_unobserved' };
    }
    await recordScreenshotError(
      screenshotPhase === 'upload' ? 'upload_failed' : 'capture_failed',
      Date.now(),
      screenshotAuthContext,
    );
    console.warn('[Screenshot] Capture error:', safeDiagnosticError(error));
  } finally {
    screenshotAuthContext.signal.removeEventListener('abort', abortCaptureRequest);
    capturePolicySignal.removeEventListener('abort', abortCaptureRequest);
    screenshotCaptureInFlight = false;
    if (screenshotImmediateCapturePending) {
      screenshotImmediateCapturePending = false;
      Promise.resolve().then(() => captureAndSendScreenshot({
        ...options,
        reason: 'authority-change',
      })).catch(() => {});
    }
  }
}

function parseBoundedExpiry(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function captureSafetyEvidence(rawRequest, exactTargets, authContext, options = {}) {
  const request = rawRequest && typeof rawRequest === 'object' ? rawRequest : null;
  const requestId = String(request?.requestId || '').trim().slice(0, 256);
  const tabRef = String(request?.tabRef || '').trim().slice(0, 256);
  const snapshotRevision = Number(request?.snapshotRevision);
  const expiresAt = parseBoundedExpiry(request?.expiresAt);
  const exactTarget = exactTargets?.targets?.find((target) => target.tabRef === tabRef);
  if (!hasNegotiatedCapability('safetyEvidenceCaptureV1', authContext)
    || !requestId
    || !tabRef
    || !Number.isSafeInteger(snapshotRevision)
    || snapshotRevision < 1
    || snapshotRevision !== exactTargets?.revision
    || !exactTarget
    || expiresAt <= Date.now()
    || expiresAt > Date.now() + 35 * 1000) {
    return { status: 'unavailable', reason: 'invalid_or_unnegotiated_request' };
  }
  if (!currentLicenseIsActive() || trackingState === TRACKING_STATES.OFF || isScheduleHardOff) {
    return { status: 'unavailable', reason: 'monitoring_inactive' };
  }

  const timeoutController = new AbortController();
  const onAuthorityAbort = () => timeoutController.abort();
  authContext.signal.addEventListener('abort', onAuthorityAbort, { once: true });
  const timeoutId = setTimeout(() => timeoutController.abort(), 3000);
  const timeout = new Promise((_, reject) => {
    timeoutController.signal.addEventListener('abort', () => {
      const error = new Error('Safety evidence capture timed out');
      error.code = authContext.signal.aborted
        ? 'AUTH_CONTEXT_SUPERSEDED'
        : 'SAFETY_EVIDENCE_TIMEOUT';
      reject(error);
    }, { once: true });
  });

  try {
    return await Promise.race([(async () => {
      assertAuthenticatedContextCurrent(authContext, 'safety evidence capture');
      if (!currentLicenseIsActive() || trackingState === TRACKING_STATES.OFF || isScheduleHardOff) {
        return { status: 'unavailable', reason: 'monitoring_inactive' };
      }
      const getTab = options.getTab || ((tabId) => chrome.tabs.get(tabId));
      const captureVisibleTab = options.captureVisibleTab
        || ((windowId, captureOptions) => chrome.tabs.captureVisibleTab(windowId, captureOptions));
      const resolveExactTargets = options.resolveExactTargets || resolveExactTabRefs;
      let verified = await revalidateExactTabTargets(exactTargets, authContext, resolveExactTargets);
      let verifiedTarget = verified.targets.find((target) => target.tabRef === tabRef);
      if (!verifiedTarget || verifiedTarget.tabId !== exactTarget.tabId) {
        return { status: 'unavailable', reason: 'stale_tab_snapshot' };
      }
      const tab = await getTab(verifiedTarget.tabId);
      assertAuthenticatedContextCurrent(authContext, 'safety evidence tab');
      if (!currentLicenseIsActive() || trackingState === TRACKING_STATES.OFF || isScheduleHardOff) {
        return { status: 'unavailable', reason: 'monitoring_inactive' };
      }
      if (!tab?.active || !Number.isInteger(tab.windowId) || !isHttpUrl(tab.url)) {
        return { status: 'unavailable', reason: 'target_not_visible' };
      }
      let activationChanged = false;
      const unsubscribeActivation = subscribeTabActivationFence(
        tab,
        () => { activationChanged = true; },
        options.subscribeTabActivation,
      );
      const unsubscribeNavigation = subscribeTabNavigationFence(
        tab,
        () => { activationChanged = true; },
        options.subscribeTabUpdate,
      );
      let dataUrl;
      try {
        const beforeCaptureTab = await getTab(verifiedTarget.tabId);
        assertAuthenticatedContextCurrent(authContext, 'safety evidence pre-capture tab');
        if (activationChanged || !isSameActiveCaptureTab(beforeCaptureTab, tab)) {
          return { status: 'unavailable', reason: 'active_tab_changed' };
        }
        dataUrl = await captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 50 });
        assertAuthenticatedContextCurrent(authContext, 'safety evidence pixels');
        const afterCaptureTab = await getTab(verifiedTarget.tabId);
        assertAuthenticatedContextCurrent(authContext, 'safety evidence post-capture tab');
        if (activationChanged || !isSameActiveCaptureTab(afterCaptureTab, tab)) {
          return { status: 'unavailable', reason: 'active_tab_changed' };
        }
      } finally {
        unsubscribeActivation?.();
        unsubscribeNavigation?.();
      }
      if (!currentLicenseIsActive() || trackingState === TRACKING_STATES.OFF || isScheduleHardOff) {
        return { status: 'unavailable', reason: 'monitoring_inactive' };
      }
      verified = await revalidateExactTabTargets(exactTargets, authContext, resolveExactTargets);
      verifiedTarget = verified.targets.find((target) => target.tabRef === tabRef);
      if (!verifiedTarget || verifiedTarget.tabId !== exactTarget.tabId) {
        return { status: 'unavailable', reason: 'stale_tab_snapshot' };
      }
      if (!dataUrl || expiresAt <= Date.now()) {
        return { status: 'unavailable', reason: 'capture_empty_or_expired' };
      }
      const capturedAt = new Date().toISOString();
      assertAuthenticatedContextCurrent(authContext, 'safety evidence upload');
      const response = await fetchWithBackoff(
        `${authContext.serverOrigin}/api/classpilot/device/screenshot`,
        {
          method: 'POST',
          headers: buildDeviceAuthHeaders(authContext),
          body: JSON.stringify({
            ...extensionProtocolDescriptor(),
            captureKind: 'safety_evidence',
            evidenceRequestId: requestId,
            tabRef,
            tabSnapshotRevision: snapshotRevision,
            capturedAt,
            screenshot: dataUrl,
            tabTitle: String(tab.title || '').slice(0, 512),
            tabUrl: String(tab.url || '').slice(0, 2048),
            tabFavicon: String(tab.favIconUrl || '').slice(0, 2048),
          }),
          signal: timeoutController.signal,
        },
        {
          context: 'safety evidence upload',
          maxAttempts: 1,
          respectGlobalBackoff: false,
        },
      );
      assertAuthenticatedContextCurrent(authContext, 'safety evidence upload');
      if (!currentLicenseIsActive() || trackingState === TRACKING_STATES.OFF || isScheduleHardOff) {
        return { status: 'unavailable', reason: 'monitoring_inactive' };
      }
      return response.ok
        ? { status: 'available', requestId }
        : { status: 'unavailable', reason: 'upload_rejected' };
    })(), timeout]);
  } catch (error) {
    if (isAuthContextCancellation(error)) throw error;
    return {
      status: 'unavailable',
      reason: error?.code === 'SAFETY_EVIDENCE_TIMEOUT'
        ? 'timeout'
        : error?.code === 'STALE_TAB_SNAPSHOT' || error?.code === 'TAB_REF_NOT_FOUND'
          ? 'stale_tab_snapshot'
          : 'capture_failed',
    };
  } finally {
    clearTimeout(timeoutId);
    authContext.signal.removeEventListener('abort', onAuthorityAbort);
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
let globalBlockedDomainsScope = null;
let schoolPolicyMutation = Promise.resolve();
let teacherBlockedDomains = []; // Teacher-applied session blacklist
let activeBlockListName = null; // Name of the currently active teacher block list
let temporaryAllowedDomains = []; // Temporarily unblocked domains with expiry times: [{ domain, expiresAt }]
let attentionModeActive = false; // When true, blocks navigation and new tabs
let restrictionSsoPassThroughActive = false;
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
const AUTHORITY_BOUND_TAB_COMMAND_TYPES = new Set([
  'open-tab',
  'close-tab',
  'close-tabs',
  'limit-tabs',
]);
let currentClassroomState = null;
let lastClassroomStateSyncRequestAt = 0;
let lastClassroomHeartbeatSyncRequestAt = 0;
let lastFabHeartbeatSyncRequestAt = 0;
const FAB_HEARTBEAT_DISCONNECTED_SYNC_INTERVAL_MS = 30 * 1000;
const FAB_HEARTBEAT_CONNECTED_SYNC_INTERVAL_MS = 5 * 60 * 1000;
let lastClassroomStateOutcome = 'pending';
let lastClassroomStateAckRevision = 0;
let lastClassroomStateAckAuthBinding = null;
let classroomStateApplicationTail = Promise.resolve();
let classroomRuntimeOwnerSequence = 0;
let classroomRuntimeOwner = null;

function createClassroomRuntimeOwner(authContext, revision = 0) {
  classroomRuntimeOwnerSequence += 1;
  return Object.freeze({
    id: classroomRuntimeOwnerSequence,
    authContextId: authContext?.authContextId || null,
    authGeneration: authContext?.generation ?? null,
    revision: Number.isSafeInteger(Number(revision)) ? Number(revision) : 0,
  });
}

function classroomRuntimeIsOwnedBy(owner) {
  return Boolean(owner && classroomRuntimeOwner === owner);
}

function createClassroomTabMutationJournal() {
  return {
    createdTabIds: new Set(),
    updatedTabs: new Map(),
    removedTabs: new Map(),
  };
}

function snapshotRestorableTab(tab) {
  if (!Number.isInteger(tab?.id) || !isHttpUrl(tab.url)) return null;
  return {
    id: tab.id,
    url: tab.url,
    active: tab.active === true,
    pinned: tab.pinned === true,
    windowId: Number.isInteger(tab.windowId) ? tab.windowId : undefined,
    index: Number.isInteger(tab.index) ? tab.index : undefined,
  };
}

function rememberClassroomTabUpdate(journal, tab) {
  const snapshot = snapshotRestorableTab(tab);
  if (!journal || !snapshot || journal.updatedTabs.has(snapshot.id)) return;
  journal.updatedTabs.set(snapshot.id, snapshot);
}

function rememberClassroomTabRemoval(journal, tab) {
  const snapshot = snapshotRestorableTab(tab);
  if (!journal || !snapshot || journal.removedTabs.has(snapshot.id)) return;
  journal.removedTabs.set(snapshot.id, snapshot);
}

async function compensateClassroomTabMutations(journal) {
  if (!journal) return true;
  let complete = true;
  const currentTabs = await chrome.tabs.query({}).catch(() => []);
  const currentById = new Map(currentTabs.map((tab) => [tab.id, tab]));

  for (const tabId of journal.createdTabIds) {
    if (!currentById.has(tabId)) continue;
    try {
      await chrome.tabs.remove(tabId);
      currentById.delete(tabId);
    } catch {
      complete = false;
    }
  }

  for (const [tabId, removed] of journal.removedTabs) {
    if (journal.createdTabIds.has(tabId) || currentById.has(tabId)) continue;
    const original = journal.updatedTabs.get(tabId) || removed;
    try {
      await chrome.tabs.create({
        url: original.url,
        active: original.active,
        pinned: original.pinned,
        ...(Number.isInteger(original.windowId) ? { windowId: original.windowId } : {}),
        ...(Number.isInteger(original.index) ? { index: original.index } : {}),
      });
    } catch {
      complete = false;
    }
  }

  for (const [tabId, original] of journal.updatedTabs) {
    if (journal.removedTabs.has(tabId) || !currentById.has(tabId)) continue;
    try {
      await chrome.tabs.update(tabId, {
        url: original.url,
        active: original.active,
        pinned: original.pinned,
      });
    } catch {
      complete = false;
    }
  }
  return complete;
}

async function scrubRetiredClassroomTabMutations(journal) {
  if (!journal) return true;
  // Never recreate or navigate to URLs captured under retired authority. Close
  // tabs that the retired operation created or redirected; already-removed
  // tabs remain removed. This avoids rehydrating A's URL/title data while B is
  // waiting to adopt the shared browser.
  const tabIds = new Set([
    ...journal.createdTabIds,
    ...journal.updatedTabs.keys(),
  ]);
  let complete = true;
  for (const tabId of tabIds) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      complete = false;
    }
  }
  return complete;
}

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
    restrictionSsoPassThroughActive,
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
  restrictionSsoPassThroughActive = backup.restrictionSsoPassThroughActive;
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

function sendClassroomStateAck(state, outcome, error, authContext = null) {
  if (authContext) {
    try {
      assertAuthenticatedContextCurrent(authContext, 'classroom state acknowledgement');
    } catch (contextError) {
      if (isAuthContextCancellation(contextError)) return false;
      throw contextError;
    }
  }
  lastClassroomStateOutcome = outcome;
  lastClassroomStateAckAuthBinding = authContext
    ? monitoringEventAuthBindingForContext(authContext)
    : null;
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

function classroomStateFromRuntimeForReconciliation() {
  return {
    ...(restrictionSsoPassThroughActive
      ? { deliveryContext: { lateSignInRestrictionSso: true } }
      : {}),
    restrictions: classroomRestrictionsFromRuntime(),
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

async function setRuntimeFromClassroomState(state, options = {}) {
  const authContext = options.authContext || null;
  const authorityEnvelope = options.authorityEnvelope || state;
  const runtimeOwner = options.runtimeOwner
    || createClassroomRuntimeOwner(authContext, state?.revision);
  const assertCurrent = (reason = 'classroom runtime application') => {
    if (!authContext) return;
    assertAuthenticatedContextCurrent(authContext, reason);
    const binding = assertCurrentStudentBinding(authorityEnvelope, reason, { authContext });
    assertBindingMatchesAuthContext(binding, authContext, reason);
  };
  assertCurrent();
  classroomRuntimeOwner = runtimeOwner;
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
  restrictionSsoPassThroughActive = restrictionSsoPassThroughForState(state);
  teacherMaxTabs = restrictions.tabLimit;
  currentMaxTabs = effectiveTabLimit();

  try {
    assertCurrent();
    await composeAllManagedDynamicRules();
    assertCurrent('classroom DNR application');
  } catch (error) {
    if (!isAuthContextCancellation(error) && classroomRuntimeIsOwnedBy(runtimeOwner)) {
      restoreClassroomRuntimeBackup(backup);
      classroomRuntimeOwner = null;
    }
    throw error;
  }

  try {
    assertCurrent();
    if (authContext) await broadcastToAllTabsForAuth('attention-mode', {
      active: attentionModeActive,
      message: restrictions.attentionMode.message || 'Please look up!',
    }, authContext, authorityEnvelope);
    else await broadcastToAllTabs('attention-mode', {
      active: attentionModeActive,
      message: restrictions.attentionMode.message || 'Please look up!',
    });
    assertCurrent('classroom attention reconciliation');
  } catch (error) {
    if (isAuthContextCancellation(error)) throw error;
    console.warn('[Classroom State] Attention overlay reconciliation failed:', safeDiagnosticError(error));
  }
  // DNR is the durable enforcement boundary. Browser tabs are inherently
  // racy, so failure to query/update one must never roll back or clear the
  // newly composed rules. Retry tab reconciliation independently instead.
  await reconcileClassroomStateTabsBestEffort(state, {
    authContext,
    assertCurrent,
    runtimeOwner,
    tabMutationJournal: options.tabMutationJournal,
  });
  return runtimeOwner;
}

async function failPrivateRetiredClassroomRuntime(expectedOwner = null) {
  if (expectedOwner && !classroomRuntimeIsOwnedBy(expectedOwner)) return false;
  const cleanupOwner = expectedOwner || classroomRuntimeOwner;
  classroomRuntimeOwner = null;
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
  restrictionSsoPassThroughActive = false;
  currentClassroomState = null;
  await composeDynamicRules(['classroom', 'teacher', 'temporary', 'restrictionSso']);
  await kv.remove([
    'lockScreenState',
    'flightPathState',
    'teacherBlockListState',
    CLASSROOM_STATE_STORAGE_KEY,
    CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY,
    CLASSROOM_STATE_STUDENT_BINDING_KEY,
  ]);
  if (hasSessionStorage()) {
    await durableSessionKv.remove(CLASSROOM_STATE_STUDENT_BINDING_KEY);
  }
  await chrome.alarms.clear(CLASSROOM_STATE_EXPIRY_ALARM);
  return !classroomRuntimeOwner || classroomRuntimeOwner === cleanupOwner;
}

function scheduleClassroomStateReconciliationRetry() {
  chrome.alarms.create(CLASSROOM_STATE_RECONCILE_ALARM, {
    when: Date.now() + CLASSROOM_STATE_RECONCILE_RETRY_MS,
  });
}

async function handleClassroomStateReconcileAlarm(options = {}) {
  let authContext = options.authContext || null;
  if (!authContext) {
    try {
      authContext = captureAuthenticatedContext('classroom reconciliation alarm');
    } catch {
      // On worker wake, authentication may not be restored until the same
      // startup barrier that restores the classroom snapshot completes.
    }
  }
  await (options.restorePromise || classroomStateRestorePromise);
  if (!authContext) {
    try {
      authContext = captureAuthenticatedContext('classroom reconciliation alarm');
    } catch {
      await chrome.alarms.clear(CLASSROOM_STATE_RECONCILE_ALARM);
      return false;
    }
  }
  const reconcile = options.reconcile || reconcileClassroomStateTabsBestEffort;

  return enqueueStudentAuthMutation(() => enqueueClassroomStateOperation(async () => {
    assertAuthenticatedContextCurrent(authContext, 'classroom reconciliation alarm');
    const state = currentClassroomState;
    const runtimeOwner = classroomRuntimeOwner;
    if (!state) {
      await chrome.alarms.clear(CLASSROOM_STATE_RECONCILE_ALARM);
      return false;
    }
    const journal = createClassroomTabMutationJournal();
    const assertCurrent = (reason = 'classroom reconciliation alarm') => {
      assertAuthenticatedContextCurrent(authContext, reason);
      if (currentClassroomState !== state || classroomRuntimeOwner !== runtimeOwner) {
        throw authContextSuperseded(reason);
      }
    };
    try {
      assertCurrent();
      await reconcile(state, {
        authContext,
        assertCurrent,
        runtimeOwner,
        tabMutationJournal: journal,
      });
      assertCurrent();
      return true;
    } catch (error) {
      if (isAuthContextCancellation(error)) {
        if (currentClassroomState === state && classroomRuntimeOwner === runtimeOwner) {
          await failPrivateRetiredClassroomRuntime(runtimeOwner).catch(() => false);
        }
        await scrubRetiredClassroomTabMutations(journal).catch(() => false);
      }
      throw error;
    }
  }));
}

async function reconcileClassroomStateTabsBestEffort(state, options = {}) {
  const assertCurrent = options.assertCurrent || (() => {});
  try {
    assertCurrent('classroom tab reconciliation');
    await reconcileExistingTabsForClassroomState(
      state,
      assertCurrent,
      options.authContext,
      options.tabMutationJournal,
      {
        foregroundRestrictionSsoTabId: options.foregroundRestrictionSsoTabId,
      },
    );
    assertCurrent('classroom tab reconciliation');
    await chrome.alarms.clear(CLASSROOM_STATE_RECONCILE_ALARM);
    assertCurrent('classroom tab reconciliation');
    return true;
  } catch (error) {
    if (isAuthContextCancellation(error)) throw error;
    console.warn('[Classroom State] Existing-tab reconciliation deferred:', safeDiagnosticError(error));
    scheduleClassroomStateReconciliationRetry();
    return false;
  }
}

async function reconcileExistingTabsForClassroomState(
  state,
  assertCurrent = () => {},
  authContext = null,
  tabMutationJournal = null,
  browserApi = {},
) {
  const queryTabs = browserApi.queryTabs || ((query) => chrome.tabs.query(query));
  const updateTab = browserApi.updateTab || ((tabId, properties) => chrome.tabs.update(tabId, properties));
  const getTab = browserApi.getTab || ((tabId) => chrome.tabs.get(tabId));
  const removeTab = browserApi.removeTab || ((tabId) => chrome.tabs.remove(tabId));
  const createTab = browserApi.createTab || ((properties) => chrome.tabs.create(properties));
  const focusWindow = browserApi.focusWindow || ((windowId) => (
    chrome.windows?.update ? chrome.windows.update(windowId, { focused: true }) : Promise.resolve()
  ));
  const refreshTabs = browserApi.refreshTabs || refreshTabCache;
  assertCurrent('classroom tab query');
  const tabs = await queryTabs({});
  assertCurrent('classroom tab query');
  const foregroundTabs = await queryTabs({ active: true, lastFocusedWindow: true });
  assertCurrent('classroom foreground tab query');
  const queriedForegroundTab = foregroundTabs.find((tab) => Number.isInteger(tab?.id)) || null;
  const hintedForegroundSso = restrictionSsoPassThroughForState(state)
    && Number.isInteger(browserApi.foregroundRestrictionSsoTabId)
    ? tabs.find((tab) => (
        tab.id === browserApi.foregroundRestrictionSsoTabId
        && RuntimeCore.isRestrictionSsoTab(tab)
      )) || null
    : null;
  // An active exact-SSO onCreated observation is stronger than Chrome's
  // asynchronously updated last-focused-window query. The hint is accepted
  // only for a fresh tab in this inventory and only for a marked restriction.
  const foregroundTab = hintedForegroundSso || queriedForegroundTab;
  const plan = RuntimeCore.planClassroomTabReconciliation(state, tabs, {
    foregroundTabId: foregroundTab?.id,
    preserveRestrictionSsoTabIds: hintedForegroundSso ? [hintedForegroundSso.id] : [],
    maxTabs: currentMaxTabs,
    restrictionSsoPassThrough: restrictionSsoPassThroughForState(state),
    visitedSsoHosts: [...visitedRestrictionSsoHosts],
  });
  const failedUpdateIds = new Set();
  for (const update of plan.updates) {
    try {
      assertCurrent('classroom tab update');
      rememberClassroomTabUpdate(
        tabMutationJournal,
        tabs.find((tab) => tab.id === update.tabId),
      );
      await updateTab(update.tabId, { url: update.url });
      assertCurrent('classroom tab update');
    } catch (error) {
      if (isAuthContextCancellation(error)) throw error;
      failedUpdateIds.add(update.tabId);
      // A tab may disappear between query and update. A replacement below
      // prevents that race from leaving the student without the lock target.
      console.warn('[Classroom State] Retained tab disappeared during reconciliation:', safeDiagnosticError(error));
    }
  }
  for (const tabId of plan.removeTabIds) {
    try {
      assertCurrent('classroom tab removal');
      rememberClassroomTabRemoval(
        tabMutationJournal,
        tabs.find((tab) => tab.id === tabId),
      );
      await removeTab(tabId);
      assertCurrent('classroom tab removal');
    } catch (error) {
      if (isAuthContextCancellation(error)) throw error;
      // Closed-by-user races are already compliant with the desired state.
      console.info('[Classroom State] Exact retained tab already closed during reconciliation');
    }
  }
  let fallbackUrl = plan.createUrl;
  if (Number.isInteger(plan.activateTabId)) {
    if (failedUpdateIds.has(plan.activateTabId)) {
      fallbackUrl = fallbackUrl || plan.focusFallbackUrl;
    } else {
      try {
        assertCurrent('classroom tab activation');
        // Focus-only change: deliberately NOT journaled — authority-handover
        // scrubbing closes journaled updated tabs, which would kill the
        // student's compliant tab.
        const activatedTab = await updateTab(plan.activateTabId, { active: true });
        assertCurrent('classroom tab activation');
        const targetTab = Number.isInteger(activatedTab?.windowId)
          ? activatedTab
          : await getTab(plan.activateTabId);
        assertCurrent('classroom window focus');
        if (Number.isInteger(targetTab?.windowId)) {
          await focusWindow(targetTab.windowId);
          assertCurrent('classroom window focus');
        }
        const verified = await queryTabs({ active: true, lastFocusedWindow: true });
        assertCurrent('classroom foreground verification');
        if (!verified.some((tab) => tab.id === plan.activateTabId)) {
          throw new Error('Classroom target did not become the foreground tab');
        }
      } catch (error) {
        if (isAuthContextCancellation(error)) throw error;
        fallbackUrl = fallbackUrl || plan.focusFallbackUrl;
        console.warn('[Classroom State] Foreground target disappeared during reconciliation:', safeDiagnosticError(error));
      }
    }
  }
  const foregroundUpdateFailure = plan.updates.find((update) => (
    failedUpdateIds.has(update.tabId)
    && (update.tabId === foregroundTab?.id || update.tabId === plan.activateTabId
      || state?.restrictions?.screenLock?.active)
  ));
  fallbackUrl = fallbackUrl || foregroundUpdateFailure?.url || null;
  if (fallbackUrl) {
    // A failed update of a background destination tab must not turn the one
    // allowed fallback into a focus steal while Clever/Google authentication
    // is active. Re-read the protected candidates at the destructive boundary
    // so a completed/closed SSO flow does not unnecessarily suppress normal
    // foreground enforcement. Do not use `tab.active` from the all-window
    // inventory here: Chrome has one active tab in every background window. A
    // fresh last-focused exact-SSO tab or the validated onCreated hint is the
    // only evidence that creating an active destination would steal focus.
    let preserveRestrictionSsoFocus = false;
    if (hintedForegroundSso) {
      const candidate = await getTab(hintedForegroundSso.id).catch(() => null);
      assertCurrent('classroom fallback SSO focus verification');
      preserveRestrictionSsoFocus = RuntimeCore.isRestrictionSsoTab(candidate);
    }
    if (!preserveRestrictionSsoFocus && restrictionSsoPassThroughForState(state)) {
      const freshForegroundTabs = await queryTabs({ active: true, lastFocusedWindow: true });
      assertCurrent('classroom fallback foreground SSO verification');
      preserveRestrictionSsoFocus = freshForegroundTabs.some((tab) => (
        Number.isInteger(tab?.id) && RuntimeCore.isRestrictionSsoTab(tab)
      ));
    }
    assertCurrent('classroom tab creation');
    const createdTab = await createTab({
      url: fallbackUrl,
      active: !preserveRestrictionSsoFocus,
    });
    if (Number.isInteger(createdTab?.id)) tabMutationJournal?.createdTabIds.add(createdTab.id);
    assertCurrent('classroom tab creation');
    if (!preserveRestrictionSsoFocus && Number.isInteger(createdTab?.windowId)) {
      await focusWindow(createdTab.windowId);
      assertCurrent('classroom fallback window focus');
    }
    if (!preserveRestrictionSsoFocus && Number.isInteger(createdTab?.id)) {
      const verified = await queryTabs({ active: true, lastFocusedWindow: true });
      assertCurrent('classroom fallback foreground verification');
      if (!verified.some((tab) => tab.id === createdTab.id)) {
        throw new Error('Classroom fallback did not become the foreground tab');
      }
    }
  }
  await refreshTabs(authContext);
  assertCurrent('classroom tab cache refresh');
}

async function resolveCurrentUrlMarker(rawState, assertCurrent = () => {}) {
  const cloned = JSON.parse(JSON.stringify(rawState));
  const restrictions = cloned.restrictions || cloned.desiredRestrictions || cloned.desiredState;
  const screenLock = restrictions?.screenLock || restrictions?.screen_lock;
  if (screenLock?.url !== 'CURRENT_URL' && screenLock?.lockedUrl !== 'CURRENT_URL') return cloned;
  assertCurrent('classroom current-tab marker');
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  assertCurrent('classroom current-tab marker');
  const activeTab = tabs.find((tab) => isHttpUrl(tab.url));
  if (!activeTab?.url) throw new Error('No active web tab is available for the screen lock');
  screenLock.url = activeTab.url;
  screenLock.lockedUrl = activeTab.url;
  screenLock.domain = extractDomain(activeTab.url);
  screenLock.lockedDomain = screenLock.domain;
  return cloned;
}

async function validateRestrictionSsoDeliveryContext(
  prepared,
  authorityEnvelope,
  authContext,
  options = {},
) {
  if (prepared?.deliveryContext?.lateSignInRestrictionSso !== true) return null;
  const trustedPersistedMarker = options.trustedPersistedRestrictionSso === true;
  if (!authContext) {
    throw new Error('Late-sign-in SSO delivery requires authenticated authority');
  }
  if (!trustedPersistedMarker) {
    const markerBinding = assertCurrentStudentBinding(
      authorityEnvelope,
      'late-sign-in SSO delivery',
      { authContext },
    );
    assertBindingMatchesAuthContext(
      markerBinding,
      authContext,
      'late-sign-in SSO delivery',
      { requireFullAuthority: true },
    );
    if (!hasNegotiatedCapability('lateSignInRestrictionSsoV1', authContext)) {
      const error = new Error('Late-sign-in SSO delivery was not negotiated');
      error.code = 'LATE_SIGNIN_SSO_NOT_NEGOTIATED';
      throw error;
    }
  }
  await ensureRestrictionSsoVisitStateForContext(authContext);
  assertAuthenticatedContextCurrent(authContext, 'late-sign-in SSO delivery');
  if (
    trustedPersistedMarker
    && prepared.deliveryContext.bindingDigest !== restrictionSsoVisitScopeDigest
  ) {
    // DNR survives an MV3 restart, so keep the independent fail-safe deadline
    // while making the stale marker and its visit ledger impossible to adopt
    // on a later wake. The server snapshot request repairs the retained rules.
    await clearRestrictionSsoVisitState();
    await kv.remove([
      CLASSROOM_STATE_STORAGE_KEY,
      CLASSROOM_STATE_STUDENT_BINDING_KEY,
    ]);
    assertAuthenticatedContextCurrent(authContext, 'late-sign-in SSO stale storage cleanup');
    const retainedDeadline = await kv.get([CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]);
    assertAuthenticatedContextCurrent(authContext, 'late-sign-in SSO stale deadline restore');
    const failSafeExpiryAt = Number(retainedDeadline[CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]);
    if (Number.isFinite(failSafeExpiryAt) && failSafeExpiryAt > 0) {
      await chrome.alarms.create(CLASSROOM_STATE_EXPIRY_ALARM, {
        when: Math.max(Date.now(), failSafeExpiryAt),
      });
      assertAuthenticatedContextCurrent(authContext, 'late-sign-in SSO stale deadline alarm');
    }
    const error = new Error('Stored late-sign-in SSO delivery belongs to a retired binding');
    error.code = 'RESTRICTION_SSO_STALE_STORAGE';
    throw error;
  }
  return restrictionSsoVisitScopeDigest;
}

async function applyClassroomStateNow(rawState, options = {}) {
  const authContext = options.authContext || (() => {
    try {
      return captureAuthenticatedContext('classroom state');
    } catch {
      return null;
    }
  })();
  const suppliedAuthorityEnvelope = options.authorityEnvelope || rawState;
  const suppliedAuthorityBinding = exactStudentBinding(suppliedAuthorityEnvelope);
  // Protocol-2 classroom snapshots did not carry student/session aliases. They
  // arrive only after the authenticated channel itself has been fenced, so use
  // that immutable context when the envelope supplies no authority fields at
  // all. Any supplied, partial, conflicting, or explicit V2 tuple continues to
  // validate on its own and is never completed from another object.
  const authorityEnvelope = authContext
    && suppliedAuthorityBinding.bindingVersion !== 2
    && !suppliedAuthorityBinding.studentId
    && !suppliedAuthorityBinding.studentSessionId
    ? {
        studentId: authContext.studentId,
        studentSessionId: authContext.studentSessionId,
      }
    : suppliedAuthorityEnvelope;
  const runtimeOwner = createClassroomRuntimeOwner(
    authContext,
    rawState?.revision ?? rawState?.studentControlRevision,
  );
  const tabMutationJournal = createClassroomTabMutationJournal();
  const previousControlRevision = currentStudentControlRevision();
  const assertCurrent = (reason = 'classroom state') => {
    if (authContext) assertAuthenticatedContextCurrent(authContext, reason);
  };
  let normalized;
  try {
    assertCurrent();
    const prepared = await resolveCurrentUrlMarker(rawState, assertCurrent);
    assertCurrent();
    const restrictionSsoBinding = await validateRestrictionSsoDeliveryContext(
      prepared,
      authorityEnvelope,
      authContext,
      options,
    );
    assertCurrent();
    normalized = RuntimeCore.normalizeClassroomState(prepared, Date.now());
    if (normalized?.deliveryContext?.lateSignInRestrictionSso === true) {
      normalized.deliveryContext.bindingDigest = restrictionSsoBinding;
    }
    if (authContext && exactStudentBinding(authorityEnvelope).bindingVersion === 2) {
      observeExactStudentControlRevision(
        authorityEnvelope,
        authContext,
        'classroom state control revision',
      );
    }
  } catch (error) {
    if (isAuthContextCancellation(error)) throw error;
    const ackState = classroomStateAckTarget(rawState);
    const outcome = error?.code === 'UNSUPPORTED_CLASSROOM_STATE_SCHEMA'
      ? 'unsupported'
      : 'failed';
    sendClassroomStateAck(ackState, outcome, error, authContext);
    enqueueMonitoringEvent('restriction_state_failed', {
      revision: ackState.revision,
      restrictionTypes: [],
      errorCode: commandDiagnosticCode(error, 'CLASSROOM_STATE_INVALID'),
    }, {
      teachingSessionId: ackState.teachingSessionId,
      supervisionContextId: ackState.supervisionContextId,
      authContext,
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
    sendClassroomStateAck(
      currentClassroomState,
      currentExpiry.expired ? 'expired' : 'applied',
      undefined,
      authContext,
    );
    return {
      outcome,
      appliedRevision: currentClassroomState?.revision ?? 0,
    };
  }

  const expiry = RuntimeCore.classroomStateExpiry(normalized, Date.now());
  const screenshotAuthorityChanged = normalized.teachingSessionId !== previousState?.teachingSessionId
    || currentStudentControlRevision() !== previousControlRevision;
  if (expiry.expired) {
    assertCurrent();
    currentClassroomState = normalized;
    await expireClassroomState(expiry.reason, {
      authContext,
      authorityEnvelope,
      runtimeOwner,
      tabMutationJournal,
    });
    assertCurrent();
    if (screenshotAuthorityChanged) {
      scheduleEventHeartbeat('screenshot-authority-changed');
    }
    return { outcome: 'expired', appliedRevision: normalized.revision };
  }

  const runtimeBackup = classroomRuntimeBackup();
  let statePersisted = false;
  try {
    assertCurrent();
    await setRuntimeFromClassroomState(normalized, {
      authContext,
      authorityEnvelope,
      runtimeOwner,
      tabMutationJournal,
    });
    assertCurrent();
    currentClassroomState = normalized;
    assertCurrent();
    await kv.set({
      [CLASSROOM_STATE_STORAGE_KEY]: normalized,
      [CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]: normalized.hardExpiresAt,
    });
    if (authContext?.studentId) {
      await setManualAuthState({
        [CLASSROOM_STATE_STUDENT_BINDING_KEY]: authContext.studentId,
      });
    }
    assertCurrent();
    statePersisted = true;
    await kv.remove([
      'lockScreenState',
      'flightPathState',
      'teacherBlockListState',
    ]).catch((error) => {
      console.warn('[Classroom State] Legacy state cleanup failed:', safeDiagnosticError(error));
    });
    assertCurrent();
    scheduleClassroomStateExpiry(normalized);
    sendClassroomStateAck(normalized, 'applied', undefined, authContext);
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
      { ...eventScope, authContext }
    ).catch(() => {});
    const scopeChanged = normalized.teachingSessionId !== previousState?.teachingSessionId
      || normalized.supervisionContextId !== previousState?.supervisionContextId;
    if (screenshotAuthorityChanged) {
      scheduleEventHeartbeat('screenshot-authority-changed');
    }
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
        authContext,
      }).catch((error) => {
        console.warn('[Classroom State] Scope monitoring event was deferred:', safeDiagnosticError(error));
      });
    }
    return { outcome: 'applied', appliedRevision: normalized.revision };
  } catch (error) {
    if (isAuthContextCancellation(error)) {
      await failPrivateRetiredClassroomRuntime(runtimeOwner).then((cleaned) => {
        if (!cleaned && classroomRuntimeIsOwnedBy(runtimeOwner)) {
          scheduleClassroomStateReconciliationRetry();
        }
      }).catch((cleanupError) => {
        console.warn(
          '[Classroom State] Retired snapshot cleanup deferred:',
          safeDiagnosticError(cleanupError),
        );
        scheduleClassroomStateReconciliationRetry();
      });
      await scrubRetiredClassroomTabMutations(tabMutationJournal).catch(() => false);
      throw error;
    }
    // Once the snapshot and its fail-safe deadline are durable, retain them.
    // Non-critical notification/event failures must never clear enforcement
    // or resurrect the previous revision.
    if (statePersisted) {
      currentClassroomState = normalized;
      scheduleClassroomStateExpiry(normalized);
      sendClassroomStateAck(normalized, 'applied', undefined, authContext);
      console.warn('[Classroom State] Snapshot persisted with a deferred side effect:', safeDiagnosticError(error));
      return { outcome: 'applied', appliedRevision: normalized.revision };
    }
    try {
      assertCurrent('classroom state rollback');
      if (!classroomRuntimeIsOwnedBy(runtimeOwner)) {
        throw authContextSuperseded('classroom state rollback');
      }
      restoreClassroomRuntimeBackup(runtimeBackup);
      currentClassroomState = previousState;
      await composeAllManagedDynamicRules();
      assertCurrent('classroom state rollback');
      if (!classroomRuntimeIsOwnedBy(runtimeOwner)) {
        throw authContextSuperseded('classroom state rollback');
      }
      if (authContext) {
        await broadcastToAllTabsForAuth('attention-mode', {
          active: attentionModeActive,
          message: previousState?.restrictions?.attentionMode?.message || '',
        }, authContext, authorityEnvelope);
      } else {
        await broadcastToAllTabs('attention-mode', {
          active: attentionModeActive,
          message: previousState?.restrictions?.attentionMode?.message || '',
        });
      }
      assertCurrent('classroom state rollback');
      if (previousState) {
        await kv.set({
          [CLASSROOM_STATE_STORAGE_KEY]: previousState,
          [CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]: previousState.hardExpiresAt,
        });
        if (authContext?.studentId) {
          await setManualAuthState({
            [CLASSROOM_STATE_STUDENT_BINDING_KEY]: authContext.studentId,
          });
        }
        assertCurrent('classroom state rollback');
        scheduleClassroomStateExpiry(previousState);
      } else {
        await kv.remove([
          CLASSROOM_STATE_STORAGE_KEY,
          CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY,
          CLASSROOM_STATE_STUDENT_BINDING_KEY,
        ]);
        if (hasSessionStorage()) {
          await durableSessionKv.remove(CLASSROOM_STATE_STUDENT_BINDING_KEY);
        }
        assertCurrent('classroom state rollback');
        await chrome.alarms.clear(CLASSROOM_STATE_EXPIRY_ALARM);
        assertCurrent('classroom state rollback');
      }
      await compensateClassroomTabMutations(tabMutationJournal);
      assertCurrent('classroom state rollback');
    } catch (rollbackError) {
      if (isAuthContextCancellation(rollbackError)) {
        await failPrivateRetiredClassroomRuntime(runtimeOwner).catch((cleanupError) => {
          console.warn(
            '[Classroom State] Retired rollback cleanup deferred:',
            safeDiagnosticError(cleanupError),
          );
          scheduleClassroomStateReconciliationRetry();
        });
        await scrubRetiredClassroomTabMutations(tabMutationJournal).catch(() => false);
        throw rollbackError;
      }
      console.warn('[Classroom State] Snapshot rollback failed:', safeDiagnosticError(rollbackError));
      scheduleClassroomStateReconciliationRetry();
    }
    sendClassroomStateAck(normalized, 'failed', error, authContext);
    enqueueMonitoringEvent('restriction_state_failed', {
      revision: normalized.revision,
      restrictionTypes: classroomRestrictionTypes(normalized),
      errorCode: error?.name || 'apply_failed',
    }, {
      teachingSessionId: normalized.teachingSessionId,
      supervisionContextId: normalized.supervisionContextId,
      authContext,
    }).catch(() => {});
    throw error;
  }
}

function applyClassroomState(rawState, options = {}) {
  return enqueueClassroomStateOperation(() => applyClassroomStateNow(rawState, options));
}

async function expireClassroomState(reason = 'hard_expiry', options = {}) {
  if (!currentClassroomState) return;
  const authContext = options.authContext || (() => {
    try {
      return captureAuthenticatedContext('classroom state expiry');
    } catch {
      return null;
    }
  })();
  const authorityEnvelope = options.authorityEnvelope || (authContext ? {
    studentId: authContext.studentId,
    studentSessionId: authContext.studentSessionId,
  } : null);
  const runtimeOwner = options.runtimeOwner
    || createClassroomRuntimeOwner(authContext, currentClassroomState.revision);
  const assertCurrent = (label = 'classroom state expiry') => {
    if (!authContext) return;
    assertAuthenticatedContextCurrent(authContext, label);
    const binding = assertCurrentStudentBinding(authorityEnvelope, label, { authContext });
    assertBindingMatchesAuthContext(binding, authContext, label);
  };
  try {
    assertCurrent();
    if (activeLiveViewNegotiationId) {
      await stopScreenShare({ reason: `classroom-state-${reason}` });
      assertCurrent();
    }
    const expiredState = {
      ...currentClassroomState,
      restrictions: RuntimeCore.emptyRestrictions(),
      expiredAt: Date.now(),
      expiryReason: reason,
    };
    await setRuntimeFromClassroomState(expiredState, {
      authContext,
      authorityEnvelope,
      runtimeOwner,
      tabMutationJournal: options.tabMutationJournal,
    });
    assertCurrent();
    currentClassroomState = expiredState;
    await kv.set({
      [CLASSROOM_STATE_STORAGE_KEY]: expiredState,
    });
    if (authContext?.studentId) {
      await setManualAuthState({
        [CLASSROOM_STATE_STUDENT_BINDING_KEY]: authContext.studentId,
      });
    }
    assertCurrent();
    await kv.remove(CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY);
    assertCurrent();
    scheduleClassroomStateExpiry(expiredState);
    sendClassroomStateAck(expiredState, 'expired', undefined, authContext);
    enqueueMonitoringEvent('restriction_state_cleared', {
      revision: expiredState.revision,
      restrictionTypes: [],
      reason,
    }, {
      teachingSessionId: expiredState.teachingSessionId,
      supervisionContextId: expiredState.supervisionContextId,
      authContext,
    }).catch(() => {});
  } catch (error) {
    if (isAuthContextCancellation(error)) {
      await failPrivateRetiredClassroomRuntime(runtimeOwner).catch((cleanupError) => {
        console.warn(
          '[Classroom State] Retired expiry cleanup deferred:',
          safeDiagnosticError(cleanupError),
        );
        scheduleClassroomStateReconciliationRetry();
      });
      await scrubRetiredClassroomTabMutations(options.tabMutationJournal).catch(() => false);
    }
    throw error;
  }
}

async function checkClassroomStateExpiryNow(options = {}) {
  const authContext = options.authContext || null;
  const assertCurrent = (reason = 'classroom-state expiry check') => {
    if (authContext) assertAuthenticatedContextCurrent(authContext, reason);
  };
  assertCurrent();
  if (!currentClassroomState) {
    const stored = await kv.get([CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]);
    assertCurrent();
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
    restrictionSsoPassThroughActive = false;
    await composeDynamicRules(['classroom', 'teacher', 'temporary', 'restrictionSso']);
    assertCurrent();
    if (authContext) {
      await broadcastToAllTabsForAuth(
        'attention-mode',
        { active: false, message: '' },
        authContext,
        browserPolicyEnvelopeForAuth(authContext),
      );
    } else {
      await broadcastToAllTabs('attention-mode', { active: false, message: '' });
    }
    assertCurrent();
    await kv.remove(CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY);
    assertCurrent();
    return;
  }
  const expiry = RuntimeCore.classroomStateExpiry(currentClassroomState, Date.now());
  if (expiry.expired) {
    await expireClassroomState(expiry.reason, {
      authContext,
      authorityEnvelope: authContext ? {
        studentId: authContext.studentId,
        studentSessionId: authContext.studentSessionId,
      } : null,
    });
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
    assertCurrent();
    await updateTemporaryAllowRules(validAllows);
    assertCurrent();
    // Commit the durable snapshot only after Chrome accepted the corresponding
    // DNR update. On failure, the retry must still see the expired entry and
    // attempt the clear again rather than treating the in-memory mutation as
    // already enforced.
    currentClassroomState = stateWithoutExpiredAllows;
    await kv.set({ [CLASSROOM_STATE_STORAGE_KEY]: currentClassroomState });
    assertCurrent();
  }
  scheduleClassroomStateExpiry(currentClassroomState);
}

function storedClassroomStateMatches(value, expectedValue) {
  try {
    return JSON.stringify(value ?? null) === JSON.stringify(expectedValue ?? null);
  } catch {
    return false;
  }
}

function recoverInvalidStoredClassroomState(
  expectedState,
  expectedStudentId,
  rawFailSafeExpiryAt,
  authContext,
) {
  return enqueueStudentAuthMutation(async () => {
    const assertCurrent = () => assertAuthenticatedContextCurrent(
      authContext,
      'worker classroom-state recovery',
    );
    assertCurrent();
    const latest = await getStoredAuthState([
      CLASSROOM_STATE_STORAGE_KEY,
      CLASSROOM_STATE_STUDENT_BINDING_KEY,
      CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY,
    ]);
    assertCurrent();
    if (
      latest[CLASSROOM_STATE_STUDENT_BINDING_KEY] !== expectedStudentId
      || !storedClassroomStateMatches(latest[CLASSROOM_STATE_STORAGE_KEY], expectedState)
    ) {
      // A newer exact snapshot won the race. Its writer owns both the state and
      // deadline, so stale recovery has nothing to mutate.
      return false;
    }
    const storedFailSafeExpiryAt = Number(
      latest[CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY] ?? rawFailSafeExpiryAt,
    );
    const failSafeExpiryAt = Number.isFinite(storedFailSafeExpiryAt)
      && storedFailSafeExpiryAt > 0
      ? storedFailSafeExpiryAt
      : Date.now();
    await kv.set({ [CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]: failSafeExpiryAt });
    assertCurrent();
    if (failSafeExpiryAt > Date.now()) {
      chrome.alarms.create(CLASSROOM_STATE_EXPIRY_ALARM, { when: failSafeExpiryAt });
      return true;
    }
    // Never invent a fresh twelve-hour window when the independently stored
    // original cutoff is absent/already elapsed. Run the fail-safe under the
    // same auth->classroom lock order, then conditionally remove only the exact
    // corrupt snapshot this recovery read.
    await enqueueClassroomStateOperation(() => checkClassroomStateExpiryNow({ authContext }));
    assertCurrent();
    const beforeRemove = await getStoredAuthState([
      CLASSROOM_STATE_STORAGE_KEY,
      CLASSROOM_STATE_STUDENT_BINDING_KEY,
    ]);
    assertCurrent();
    if (
      beforeRemove[CLASSROOM_STATE_STUDENT_BINDING_KEY] === expectedStudentId
      && storedClassroomStateMatches(beforeRemove[CLASSROOM_STATE_STORAGE_KEY], expectedState)
    ) {
      await kv.remove(CLASSROOM_STATE_STORAGE_KEY);
      assertCurrent();
    }
    return true;
  });
}

function checkClassroomStateExpiry() {
  let capturedAuthContext = null;
  try {
    capturedAuthContext = captureAuthenticatedContext('classroom-state expiry queue');
  } catch {
    // Signed-out fail-safe expiry still clears orphaned controls. A pending auth
    // mutation is serialized below before this unscoped cleanup can run.
  }
  return enqueueStudentAuthMutation(async () => {
    let authContext = capturedAuthContext;
    if (authContext) {
      assertAuthenticatedContextCurrent(authContext, 'classroom-state expiry queue');
    } else {
      try {
        authContext = captureAuthenticatedContext('classroom-state expiry queue');
      } catch {
        authContext = null;
      }
    }
    return enqueueClassroomStateOperation(() => checkClassroomStateExpiryNow({ authContext }));
  }).catch((error) => {
    // A transient DNR/storage failure must not turn a scheduled or absolute
    // cutoff into a permanent restriction. Retain the original deadline and
    // retry the teacher/class/temporary range clear until it succeeds.
    scheduleClassroomStateExpiryRetry();
    throw error;
  });
}

function assertRemoteCommandExecutionContextCurrent(
  command,
  envelope,
  executionContext,
  reason = 'remote-control command',
) {
  const authContext = executionContext?.authContext;
  if (!authContext) throw authContextSuperseded(reason);
  assertAuthenticatedContextCurrent(authContext, reason);
  const binding = assertCurrentStudentBinding(envelope, reason, { authContext });
  assertBindingMatchesAuthContext(binding, authContext, reason);
  assertCurrentCommandAuthority(command, envelope);
  return authContext;
}

async function persistLegacyClassroomState(command, envelope = {}, executionContext = {}) {
  const authContext = assertRemoteCommandExecutionContextCurrent(
    command,
    envelope,
    executionContext,
    'legacy classroom state persistence',
  );
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
  assertRemoteCommandExecutionContextCurrent(
    command,
    envelope,
    executionContext,
    'legacy classroom state persistence',
  );
  currentClassroomState = normalized;
  await kv.set({
    [CLASSROOM_STATE_STORAGE_KEY]: normalized,
    [CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]: normalized.hardExpiresAt,
  });
  if (authContext.studentId) {
    await setManualAuthState({
      [CLASSROOM_STATE_STUDENT_BINDING_KEY]: authContext.studentId,
    });
  }
  assertRemoteCommandExecutionContextCurrent(
    command,
    envelope,
    executionContext,
    'legacy classroom state persistence',
  );
  await kv.remove([
    'lockScreenState',
    'flightPathState',
    'teacherBlockListState',
  ]);
  assertRemoteCommandExecutionContextCurrent(
    command,
    envelope,
    executionContext,
    'legacy classroom state persistence',
  );
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
  const authContext = options.authContext || null;
  const sourceMessage = options.sourceMessage || null;
  const assertCurrent = (label = 'teacher broadcast cleanup') => {
    if (!authContext) return;
    assertAuthenticatedContextCurrent(authContext, label);
    const binding = assertCurrentStudentBinding(sourceMessage, label, { authContext });
    assertBindingMatchesAuthContext(binding, authContext, label);
  };
  assertCurrent();
  if (!teacherBroadcastActive && !teacherBroadcastSessionId) {
    return;
  }
  const previousSessionId = teacherBroadcastSessionId;
  teacherBroadcastActive = false;
  teacherBroadcastSessionId = null;
  if (options.notifyTeacher && wsConnected) {
    assertCurrent();
    await wsSend({
      type: 'broadcast-leave',
      sessionId: previousSessionId || undefined,
      reason,
    }, authContext);
    assertCurrent();
  }
  if (authContext) {
    await broadcastToAllTabsForAuth('teacher-broadcast-stop', {
      sessionId: previousSessionId,
      reason,
    }, authContext, sourceMessage);
    assertCurrent();
  }
}

async function handleBroadcastStart(message = {}, authContext) {
  const assertCurrent = (reason = 'teacher broadcast start') => {
    assertAuthenticatedContextCurrent(authContext, reason);
    const binding = assertCurrentStudentBinding(message, reason, { authContext });
    assertBindingMatchesAuthContext(binding, authContext, reason);
  };
  assertCurrent();
  const nextSessionId = message.sessionId || message.broadcastSessionId || null;
  if (teacherBroadcastActive && teacherBroadcastSessionId !== nextSessionId) {
    await cleanupTeacherBroadcast('replaced-by-new-broadcast', {
      notifyTeacher: true,
      authContext,
      sourceMessage: message,
    });
    assertCurrent();
  }
  teacherBroadcastActive = true;
  teacherBroadcastSessionId = nextSessionId;
  assertCurrent();
  await wsSend({
    type: 'broadcast-join',
    sessionId: nextSessionId || undefined,
  }, authContext);
  assertCurrent();
}

async function handleBroadcastStop(message, authContext) {
  await cleanupTeacherBroadcast('teacher-stop', {
    notifyTeacher: false,
    authContext,
    sourceMessage: message,
  }, authContext).catch(() => {});
  return true;
}

async function handleBroadcastOffer(message, authContext) {
  const assertCurrent = (reason = 'teacher broadcast offer') => {
    assertAuthenticatedContextCurrent(authContext, reason);
    const binding = assertCurrentStudentBinding(message, reason, { authContext });
    assertBindingMatchesAuthContext(binding, authContext, reason);
  };
  assertCurrent();
  if (!teacherBroadcastActive) {
    console.warn('[Broadcast] Ignoring offer because no broadcast session is active');
    return;
  }
  if (!message?.sdp) {
    console.warn('[Broadcast] Ignoring empty broadcast offer');
    return;
  }
  console.warn('[Broadcast] Student-side teacher broadcast viewing is not available in this extension build; leaving broadcast');
  await cleanupTeacherBroadcast('unsupported-broadcast-offer', {
    notifyTeacher: true,
    authContext,
    sourceMessage: message,
  });
  assertCurrent();
}

function handleBroadcastIce(message, authContext) {
  assertAuthenticatedContextCurrent(authContext, 'teacher broadcast ICE');
  const binding = assertCurrentStudentBinding(message, 'teacher broadcast ICE', { authContext });
  assertBindingMatchesAuthContext(binding, authContext, 'teacher broadcast ICE');
  if (!teacherBroadcastActive || !message?.candidate) {
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
  restrictionSsoPassThroughActive = false;
  seenPollIds.clear();

  const clearedRevision = currentClassroomState?.revision ?? 0;
  await composeDynamicRules(['classroom', 'teacher', 'temporary', 'restrictionSso']);
  currentClassroomState = null;
  await chrome.storage.local.remove([
    'lockScreenState',
    'flightPathState',
    'teacherBlockListState',
    CLASSROOM_STATE_STORAGE_KEY,
    CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY,
    CLASSROOM_STATE_STUDENT_BINDING_KEY,
  ]);
  if (hasSessionStorage()) {
    await durableSessionKv.remove(CLASSROOM_STATE_STUDENT_BINDING_KEY);
  }
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
    console.warn('[URL] Invalid URL value');
    return null;
  }
}

// Helper function to check if URL is on the same domain. Subdomain-aware:
// "app.ixl.com" counts as within "ixl.com", matching the DNR rules and the
// dashboard's off-task badge so enforcement layers agree.
function isOnSameDomain(url, domain) {
  if (!url || !domain) return false;
  return RuntimeCore.isHostWithinDomain(extractDomain(url), domain);
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
    const activeSessionIds = activeTeachingSessionIds();
    if (
      !activeSessionIds.includes(authority.teachingSessionId)
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

chrome.notifications?.onClosed?.addListener?.((notificationId) => {
  activeAuthBoundNotificationIds.delete(notificationId);
});

function exactTabCloseV2AuthorityRequired(command = {}, authContext = null) {
  return Boolean(
    (command.type === 'close-tab' || command.type === 'close-tabs')
    && (Array.isArray(command.data?.tabRefs) || command.data?.tabRef)
    && hasNegotiatedCapability('exactTabCloseV2', authContext)
  );
}

async function handleRemoteControl(command, envelope = {}, executionOverrides = {}) {
  const commandId = getCommandIdFromMessage(envelope, command);
  const commandType = command?.type || 'unknown';
  let authContext;
  let commandBinding;
  try {
    authContext = captureAuthenticatedContext('remote-control command');
    const requireExactTabAuthority = exactTabCloseV2AuthorityRequired(command, authContext);
    commandBinding = assertCurrentStudentBinding(envelope, 'remote-control command', {
      authContext,
      requireFullAuthority: requireExactTabAuthority,
    });
    assertBindingMatchesAuthContext(commandBinding, authContext, 'remote-control command', {
      requireFullAuthority: requireExactTabAuthority,
    });
    assertAuthenticatedContextCurrent(authContext, 'remote-control command');
  } catch (error) {
    // A command that cannot prove its exact student/session binding is not
    // acknowledged. Sending even a rejection under the current student's
    // token would let a stale envelope mutate the wrong command ledger.
    console.warn('[Command] Ignoring unbound command:', safeDiagnosticError(error));
    return { rejected: true, error: commandErrorMessage(error) };
  }

  const delivery = RuntimeCore.commandDeliveryState(command, envelope, Date.now());

  // One-shot actions never become a reconnect queue. If the device did not
  // receive the envelope before its deadline, report expiry without executing.
  // Exact binding is deliberately proven above before any ACK is created.
  if (delivery.expired) {
    if (commandId) {
      const state = await getClassroomCommandStateSnapshot();
      assertAuthenticatedContextCurrent(authContext, 'expired command acknowledgement');
      await sendCommandAck(commandId, 'expired', {
        authContext,
        binding: commandBinding,
        commandType,
        deliveryPolicy: delivery.deliveryPolicy,
        expiresAt: delivery.expiresAt,
        state,
        outcome: 'expired',
      });
    }
    return { expired: true, expiresAt: delivery.expiresAt };
  }

  let authority = null;
  try {
    authority = assertCurrentCommandAuthority(command, envelope);
  } catch (error) {
    if (commandId) {
      try {
        const state = await getClassroomCommandStateSnapshot();
        assertAuthenticatedContextCurrent(authContext, 'rejected command acknowledgement');
        await sendCommandAck(commandId, 'failed', {
          authContext,
          binding: commandBinding,
          commandType,
          error: commandErrorMessage(error),
          errorCode: commandDiagnosticCode(error, 'COMMAND_AUTHORITY_MISMATCH'),
          state,
          outcome: 'failed',
          deliveryPolicy: delivery.deliveryPolicy,
          expiresAt: delivery.expiresAt,
        });
      } catch (ackError) {
        if (!isAuthContextCancellation(ackError)) throw ackError;
      }
    }
    return { rejected: true, error: commandErrorMessage(error) };
  }

  if (commandId) {
    await sendCommandAck(commandId, 'received', {
      authContext,
      binding: commandBinding,
      commandType,
      deliveryPolicy: delivery.deliveryPolicy,
      expiresAt: delivery.expiresAt,
    });
  }

  try {
    // Re-check after the asynchronous receipt write. A class replacement may
    // have arrived while the durable ACK was being persisted.
    assertAuthenticatedContextCurrent(authContext, 'remote-control command');
    assertBindingMatchesAuthContext(
      assertCurrentStudentBinding(envelope, 'remote-control command', {
        authContext,
        requireFullAuthority: exactTabCloseV2AuthorityRequired(command, authContext),
      }),
      authContext,
      'remote-control command',
      { requireFullAuthority: exactTabCloseV2AuthorityRequired(command, authContext) },
    );
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
      application = await enqueueStudentAuthMutation(async () => {
        assertRemoteCommandExecutionContextCurrent(
          command,
          envelope,
          { authContext, binding: commandBinding },
          'stateful classroom command reservation',
        );
        return applyClassroomState(classroomState, {
          reason: 'stateful_command',
          authContext,
          authorityEnvelope: envelope,
        });
      });
      result = {
        commandType,
        stateReconciled: true,
        appliedRevision: application.appliedRevision,
        outcome: application.outcome,
        completedAt: new Date().toISOString(),
      };
    } else if (isClassroomStatefulCommand) {
      result = await enqueueStudentAuthMutation(() => enqueueClassroomStateOperation(async () => {
        const legacyExecutionContext = {
          ...executionOverrides,
          commandId,
          envelope,
          delivery,
          authContext,
          binding: commandBinding,
        };
        assertRemoteCommandExecutionContextCurrent(
          command,
          envelope,
          legacyExecutionContext,
          'legacy classroom command reservation',
        );
        const runtimeBackup = classroomRuntimeBackup();
        const stateBackup = currentClassroomState;
        const runtimeOwnerBackup = classroomRuntimeOwner;
        const runtimeOwner = createClassroomRuntimeOwner(
          authContext,
          currentClassroomState?.revision ?? currentStudentControlRevision() ?? 0,
        );
        const tabMutationJournal = createClassroomTabMutationJournal();
        legacyExecutionContext.runtimeOwner = runtimeOwner;
        legacyExecutionContext.tabMutationJournal = tabMutationJournal;
        classroomRuntimeOwner = runtimeOwner;
        try {
          const legacyResult = await executeRemoteControlCommand(
            command || {},
            legacyExecutionContext,
          );
          assertRemoteCommandExecutionContextCurrent(
            command,
            envelope,
            legacyExecutionContext,
            'legacy classroom command completion',
          );
          await persistLegacyClassroomState(command, envelope, legacyExecutionContext);
          application = {
            outcome: 'applied',
            appliedRevision: currentClassroomState?.revision ?? 0,
          };
          enqueueMonitoringEvent('restriction_state_applied', {
            revision: application.appliedRevision,
            restrictionTypes: classroomRestrictionTypes(),
            reason: 'legacy_command',
          }, { authContext }).catch(() => {});
          return legacyResult;
        } catch (error) {
          if (isAuthContextCancellation(error) || error?.code === 'STUDENT_BINDING_MISMATCH') {
            const ownsRetiredRuntime = classroomRuntimeIsOwnedBy(runtimeOwner);
            if (ownsRetiredRuntime) {
              await failPrivateRetiredClassroomRuntime(runtimeOwner).catch((cleanupError) => {
                console.warn(
                  '[Classroom State] Retired legacy command cleanup deferred:',
                  safeDiagnosticError(cleanupError),
                );
                scheduleClassroomStateReconciliationRetry();
              });
              await scrubRetiredClassroomTabMutations(tabMutationJournal).catch(() => false);
            }
            throw error;
          }
          try {
            assertRemoteCommandExecutionContextCurrent(
              command,
              envelope,
              legacyExecutionContext,
              'legacy classroom command rollback',
            );
            if (!classroomRuntimeIsOwnedBy(runtimeOwner)) {
              throw authContextSuperseded('legacy classroom command rollback');
            }
            restoreClassroomRuntimeBackup(runtimeBackup);
            currentClassroomState = stateBackup;
            await composeAllManagedDynamicRules();
            assertRemoteCommandExecutionContextCurrent(
              command,
              envelope,
              legacyExecutionContext,
              'legacy classroom command rollback',
            );
            await broadcastToAllTabsForAuth('attention-mode', {
              active: attentionModeActive,
              message: stateBackup?.restrictions?.attentionMode?.message || '',
            }, authContext, envelope);
            assertRemoteCommandExecutionContextCurrent(
              command,
              envelope,
              legacyExecutionContext,
              'legacy classroom command rollback',
            );
            await kv.remove(['lockScreenState', 'flightPathState', 'teacherBlockListState']);
            assertRemoteCommandExecutionContextCurrent(
              command,
              envelope,
              legacyExecutionContext,
              'legacy classroom command rollback',
            );
            await compensateClassroomTabMutations(tabMutationJournal);
            assertRemoteCommandExecutionContextCurrent(
              command,
              envelope,
              legacyExecutionContext,
              'legacy classroom command rollback',
            );
            classroomRuntimeOwner = runtimeOwnerBackup;
            scheduleClassroomStateExpiry(stateBackup);
          } catch (rollbackError) {
            if (isAuthContextCancellation(rollbackError)
              || rollbackError?.code === 'STUDENT_BINDING_MISMATCH') {
              const ownsRetiredRuntime = classroomRuntimeIsOwnedBy(runtimeOwner);
              if (ownsRetiredRuntime) {
                await failPrivateRetiredClassroomRuntime(runtimeOwner).catch(() => false);
                await scrubRetiredClassroomTabMutations(tabMutationJournal).catch(() => false);
              }
            }
            throw rollbackError;
          }
          throw error;
        }
      }));
    } else {
      const ordinaryExecutionContext = {
        ...executionOverrides,
        commandId,
        envelope,
        delivery,
        authContext,
        binding: commandBinding,
      };
      const executeOrdinaryCommand = () => executeRemoteControlCommand(
        command || {},
        ordinaryExecutionContext,
      );
      if (AUTHORITY_BOUND_TAB_COMMAND_TYPES.has(commandType)) {
        result = await enqueueStudentAuthMutation(async () => {
          assertRemoteCommandExecutionContextCurrent(
            command,
            envelope,
            ordinaryExecutionContext,
            'tab command reservation',
          );
          const commandResult = await executeOrdinaryCommand();
          assertRemoteCommandExecutionContextCurrent(
            command,
            envelope,
            ordinaryExecutionContext,
            'tab command completion',
          );
          return commandResult;
        });
      } else {
        result = await executeOrdinaryCommand();
      }
    }
    if (commandId) {
      const state = await getClassroomCommandStateSnapshot();
      assertAuthenticatedContextCurrent(authContext, 'completed command acknowledgement');
      await sendCommandAck(commandId, 'completed', {
        authContext,
        binding: commandBinding,
        commandType,
        result,
        state,
        appliedRevision: application?.appliedRevision,
        outcome: application?.outcome || 'applied',
        deliveryPolicy: delivery.deliveryPolicy,
        expiresAt: delivery.expiresAt,
      });
    }
    return result;
  } catch (error) {
    console.warn('Error handling remote control command:', safeDiagnosticError(error));
    if (isAuthContextCancellation(error) || error?.code === 'STUDENT_BINDING_MISMATCH') {
      return { rejected: true, error: commandErrorMessage(error) };
    }
    if (commandId) {
      const state = await getClassroomCommandStateSnapshot();
      try {
        assertAuthenticatedContextCurrent(authContext, 'failed command acknowledgement');
        await sendCommandAck(commandId, 'failed', {
          authContext,
          binding: commandBinding,
          commandType,
          error: commandErrorMessage(error),
          errorCode: commandDiagnosticCode(error),
          state,
          appliedRevision: currentClassroomState?.revision ?? 0,
          outcome: error?.code === 'UNSUPPORTED_CLASSROOM_STATE_SCHEMA' ? 'unsupported' : 'failed',
          deliveryPolicy: delivery.deliveryPolicy,
          expiresAt: delivery.expiresAt,
        });
      } catch (ackError) {
        if (!isAuthContextCancellation(ackError)) throw ackError;
      }
    }
    return { rejected: true, error: commandErrorMessage(error) };
  }
}

async function executeRemoteControlCommand(command, executionContext = {}) {
  console.log('[Command] Exact-bound remote control received:', safeDiagnosticLabel(command?.type));
  const commandAuthContext = executionContext.authContext
    || captureAuthenticatedContext(`remote-control:${command?.type || 'unknown'}`);
  const exactTabAuthorityRequired = exactTabCloseV2AuthorityRequired(
    command,
    commandAuthContext,
  );
  const commandControlRevision = executionContext.binding?.controlRevision
    ?? currentStudentControlRevision();
  const assertCommandExecutionCurrent = (reason = 'remote-control command execution') => {
    assertAuthenticatedContextCurrent(commandAuthContext, reason);
    if (executionContext.binding) {
      assertBindingMatchesAuthContext(
        executionContext.binding,
        commandAuthContext,
        reason,
        { requireFullAuthority: exactTabAuthorityRequired },
      );
    }
    if (
      exactTabAuthorityRequired
      && currentStudentControlRevision() !== commandControlRevision
    ) {
      const error = new Error(`${reason} belongs to a retired control revision`);
      error.code = 'STUDENT_BINDING_MISMATCH';
      throw error;
    }
  };
  const commandSourceMessage = executionContext.envelope || command;
  let commandNotificationSequence = 0;
  const broadcastCommandUi = async (messageType, messageData) => {
    assertCommandExecutionCurrent(`command ${messageType} broadcast`);
    await broadcastToAllTabsForAuth(
      messageType,
      messageData,
      commandAuthContext,
      commandSourceMessage,
    );
    assertCommandExecutionCurrent(`command ${messageType} broadcast`);
  };
  const notifyCommandUi = async (opts, label = command?.type || 'command') => {
    commandNotificationSequence += 1;
    assertCommandExecutionCurrent(`command ${label} notification`);
    await notifyTeacherMessageForAuth(
      opts,
      commandAuthContext,
      commandSourceMessage,
      `${executionContext.commandId || command?.commandId || label}-${commandNotificationSequence}`,
    );
    assertCommandExecutionCurrent(`command ${label} notification`);
  };
  const scheduleBoundCommandScreenshot = (delayMs) => {
    setTimeout(() => {
      try {
        assertCommandExecutionCurrent('command screenshot timer');
      } catch {
        return;
      }
      captureAndSendScreenshot({ reason: 'command' }).catch(() => {});
    }, delayMs);
  };
  const commandTabJournal = executionContext.tabMutationJournal || null;
  const updateCommandTab = async (tabId, updateProperties, knownTab = null, reason = 'command tab update') => {
    assertCommandExecutionCurrent(reason);
    const before = knownTab || await getTab(tabId);
    assertCommandExecutionCurrent(reason);
    rememberClassroomTabUpdate(commandTabJournal, before);
    const updated = await chrome.tabs.update(tabId, updateProperties);
    assertCommandExecutionCurrent(reason);
    return updated;
  };
  const removeCommandTab = async (tabId, knownTab = null, reason = 'command tab removal') => {
    assertCommandExecutionCurrent(reason);
    const before = knownTab || await getTab(tabId);
    assertCommandExecutionCurrent(reason);
    rememberClassroomTabRemoval(commandTabJournal, before);
    await chrome.tabs.remove(tabId);
    assertCommandExecutionCurrent(reason);
  };
  const createCommandTab = async (createProperties, reason = 'command tab creation') => {
    assertCommandExecutionCurrent(reason);
    const created = await chrome.tabs.create(createProperties);
    if (Number.isInteger(created?.id)) commandTabJournal?.createdTabIds.add(created.id);
    assertCommandExecutionCurrent(reason);
    return created;
  };
  assertCommandExecutionCurrent();
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
          assertCommandExecutionCurrent('open-tab command');
          const createTab = executionContext.createTab
            || ((createProperties) => chrome.tabs.create(createProperties));
          const queryTabs = executionContext.queryTabs || (() => chrome.tabs.query({}));
          const removeTab = executionContext.removeTab || ((tabId) => chrome.tabs.remove(tabId));
          const tab = await createTab({ url: command.data.url, active: true });
          try {
            assertCommandExecutionCurrent('open-tab command');
            const tabs = await queryTabs();
            assertCommandExecutionCurrent('open-tab command');
            const tabSnapshot = await buildOpaqueTabSnapshot(tabs, commandAuthContext);
            assertCommandExecutionCurrent('open-tab command');
            const openedEntry = tabSnapshot.localEntries.find((entry) => entry.tabId === tab.id);
            result.openedUrl = command.data.url;
            result.tabRef = openedEntry?.tabRef || null;
            result.tabSnapshotRevision = tabSnapshot.revision;
            console.log('[Command] Opened exact requested tab');
            // Capture screenshot after tab loads so dashboard updates fast
            scheduleBoundCommandScreenshot(2000);
          } catch (error) {
            if (Number.isInteger(tab?.id)) await removeTab(tab.id).catch(() => {});
            throw error;
          }
        }
        break;
        
      case 'close-tabs':
      case 'close-tab':
        {
          const authContext = commandAuthContext;
          assertAuthenticatedContextCurrent(authContext, 'tab close command');
          if (executionContext.binding) {
            assertBindingMatchesAuthContext(
              executionContext.binding,
              authContext,
              'tab close command',
              {
                requireFullAuthority: hasNegotiatedCapability('exactTabCloseV2', authContext)
                  && (Array.isArray(command.data.tabRefs) || Boolean(command.data.tabRef)),
              },
            );
          }
          let exact;
          if (Array.isArray(command.data.tabRefs) || command.data.tabRef) {
            if (!hasNegotiatedCapability('exactTabCloseV2', authContext)
              && !hasNegotiatedCapability('exactTabCloseV1', authContext)) {
              const capabilityError = new Error('Exact tab references were not negotiated');
              capabilityError.code = 'TAB_CLOSE_CAPABILITY_REQUIRED';
              throw capabilityError;
            }
            exact = await resolveExactTabRefs(
              command.data.tabRefs || [command.data.tabRef],
              command.data.snapshotRevision ?? command.data.tabSnapshotRevision,
              authContext,
            );
            assertCommandExecutionCurrent('exact tab resolution');
            const safetyEvidenceRequest = command.data.safetyEvidenceRequest
              || command.safetyEvidenceRequest;
            if (safetyEvidenceRequest) {
              // Evidence is attempted before the exact close, for at most
              // three seconds. An ordinary capture/upload failure does not
              // prevent the safety action from closing its exact target.
              result.safetyEvidence = await captureSafetyEvidence(
                safetyEvidenceRequest,
                exact,
                authContext,
              );
              assertCommandExecutionCurrent('safety evidence command');
            }
            await closeExactTabTargets(exact, authContext);
            assertCommandExecutionCurrent('exact tab close command');
            result.closedTabRefs = exact.targets.map((target) => target.tabRef);
            result.closedCount = exact.targets.length;
            result.tabSnapshotRevision = exact.revision;
          } else if (
            Array.isArray(command.data.specificUrls)
            || typeof command.data.url === 'string'
          ) {
            // Protocol-v2 compatibility is exact and fail-closed: a normalized
            // URL is accepted only when it identifies one currently open tab.
            exact = await resolveUniqueLegacyTabUrls(
              command.data.specificUrls || [command.data.url],
              authContext,
            );
            assertCommandExecutionCurrent('legacy exact tab resolution');
            if (command.data.safetyEvidenceRequest || command.safetyEvidenceRequest) {
              result.safetyEvidence = {
                status: 'unavailable',
                reason: 'exact_tab_reference_required',
              };
            }
            await closeExactTabTargets(exact, authContext);
            assertCommandExecutionCurrent('legacy exact tab close');
            result.closedTabRefs = exact.targets.map((target) => target.tabRef).filter(Boolean);
            result.closedCount = exact.targets.length;
            result.tabSnapshotRevision = exact.revision;
            result.legacyExactUrl = true;
          } else if (command.type === 'close-tabs' && command.data.closeAll === true) {
            // Missing target data never implies a broadcast. Closing all tabs
            // requires the explicit close-tabs action and closeAll=true.
            const queryTabs = executionContext.queryTabs || (() => chrome.tabs.query({}));
            const removeTab = executionContext.removeTab || ((tabId) => chrome.tabs.remove(tabId));
            const tabs = await queryTabs();
            assertAuthenticatedContextCurrent(authContext, 'close-all-tabs command');
            const allowedDomainSet = new Set((Array.isArray(command.data.allowedDomains)
              ? command.data.allowedDomains
              : [])
              .map((value) => extractDomain(`https://${String(value || '').replace(/^https?:\/\//, '')}`))
              .filter(Boolean));
            let closedCount = 0;
            for (const tab of tabs) {
              if (!Number.isInteger(tab?.id) || tab.url?.startsWith('chrome://')) continue;
              const tabDomain = extractDomain(tab.url);
              if (tabDomain && allowedDomainSet.has(tabDomain)) continue;
              assertAuthenticatedContextCurrent(authContext, 'close-all-tabs command');
              try {
                await removeTab(tab.id);
                assertCommandExecutionCurrent('close-all-tabs command');
                closedCount += 1;
              } catch (error) {
                if (isAuthContextCancellation(error)
                  || error?.code === 'STUDENT_BINDING_MISMATCH') {
                  throw error;
                }
                console.warn('Could not close an explicitly targeted all-tabs entry:', safeDiagnosticError(error));
              }
            }
            assertAuthenticatedContextCurrent(authContext, 'close-all-tabs command');
            result.closeAll = true;
            result.closedCount = closedCount;
            result.allowedDomains = [...allowedDomainSet];
          } else {
            const targetError = new Error('Missing exact close-tab target');
            targetError.code = 'TAB_TARGET_REQUIRED';
            throw targetError;
          }
          const refreshTabs = executionContext.refreshTabCache || refreshTabCache;
          await refreshTabs(authContext);
          assertCommandExecutionCurrent('tab cache refresh');
        }
        // Capture screenshot immediately after closing tabs so dashboard updates fast
        scheduleBoundCommandScreenshot(1500);
        break;

      case 'lock-screen':
        // Handle "CURRENT_URL" special marker - lock to current active tab
        let urlToLock = command.data.url;
        if (urlToLock === "CURRENT_URL") {
          const foregroundTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          assertCommandExecutionCurrent('lock-screen active tab');
          const activeTab = foregroundTabs.find((tab) => isHttpUrl(tab?.url));
          if (activeTab?.url) {
            urlToLock = activeTab.url;
            console.log('[Lock Screen] Using current active tab');
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
        restrictionSsoPassThroughActive = false;
        
        // Persist lock-screen state to survive service worker restarts
        await chrome.storage.local.set({
          lockScreenState: {
            screenLocked: true,
            lockedUrl,
            lockedDomain,
            timestamp: Date.now()
          }
        });
        assertCommandExecutionCurrent('lock-screen persistence');
        // Keep any independently applied Flight Path durable underneath the
        // screen-lock overlay. Screen Lock wins enforcement while active;
        // screen-only Unlock recomposes the retained path.
        console.log('[Lock Screen] State persisted to storage');
        
        // Apply network-level blocking rules for single domain
        await updateBlockingRules([lockedDomain]);
        assertCommandExecutionCurrent('lock-screen rules');
        
        await reconcileClassroomStateTabsBestEffort({
          restrictions: classroomRestrictionsFromRuntime(),
        }, {
          authContext: commandAuthContext,
          assertCurrent: assertCommandExecutionCurrent,
          runtimeOwner: executionContext.runtimeOwner,
          tabMutationJournal: commandTabJournal,
        });
        assertCommandExecutionCurrent('lock-screen tab reconciliation');
        
        // Show notification with domain
        await notifyCommandUi({
          title: 'Waypoint Set',
          message: `Your teacher set a waypoint at ${lockedDomain}. You can only browse ${lockedDomain} right now.`,
          priority: 2,
        });
        
        result.screenLocked = true;
        result.lockedUrl = lockedUrl;
        result.lockedDomain = lockedDomain;
        console.log('[Lock Screen] Screen lock applied');
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
          restrictionSsoPassThroughActive = false;
        }
        
        // Screen-only unlock deliberately preserves an independently applied
        // Flight Path. Legacy clients/commands retain the historical full
        // unlock behavior for mixed 2.5.7 deployments.
        await chrome.storage.local.remove(screenOnly
          ? ['lockScreenState']
          : ['lockScreenState', 'flightPathState']);
        assertCommandExecutionCurrent('unlock-screen persistence');
        console.log('[Unlock Screen] State cleared from storage');
        
        // Recompose the retained Flight Path immediately. Clearing all
        // classroom rules here would make a screen-only unlock silently lift
        // the still-active path until a later reconciliation.
        if (preserveFlightPath) {
          await updateBlockingRules(allowedDomains);
          assertCommandExecutionCurrent('unlock-screen rules');
          await reconcileClassroomStateTabsBestEffort({
            restrictions: classroomRestrictionsFromRuntime(),
          }, {
            authContext: commandAuthContext,
            assertCurrent: assertCommandExecutionCurrent,
            runtimeOwner: executionContext.runtimeOwner,
            tabMutationJournal: commandTabJournal,
          });
          assertCommandExecutionCurrent('unlock-screen reconciliation');
        } else {
          await clearBlockingRules();
          assertCommandExecutionCurrent('unlock-screen rules');
        }
        
        await notifyCommandUi({
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
        restrictionSsoPassThroughActive = false;
        
        // Persist Flight Path state to survive service worker restarts
        await chrome.storage.local.set({
          flightPathState: {
            screenLocked: false,
            allowedDomains,
            activeFlightPathName,
            timestamp: Date.now()
          }
        });
        assertCommandExecutionCurrent('flight-path persistence');
        await chrome.storage.local.remove('lockScreenState');
        assertCommandExecutionCurrent('flight-path persistence');
        console.log('[Flight Path] State persisted to storage');
        
        // Apply network-level blocking rules
        await updateBlockingRules(allowedDomains);
        assertCommandExecutionCurrent('flight-path rules');
        
        // Use the same foreground-aware reconciliation as revisioned state so
        // an allowed page in another window is preserved and focused.
        if (allowedDomains.length > 0) {
          await reconcileClassroomStateTabsBestEffort({
            restrictions: classroomRestrictionsFromRuntime(),
          }, {
            authContext: commandAuthContext,
            assertCurrent: assertCommandExecutionCurrent,
            runtimeOwner: executionContext.runtimeOwner,
            tabMutationJournal: commandTabJournal,
          });
          assertCommandExecutionCurrent('flight-path tabs');
          
          await notifyCommandUi({
            title: 'Flight Path Applied',
            message: `Your teacher has applied a flight path. You can only access: ${allowedDomains.join(', ')}`,
            priority: 2,
          });
        }
        
        result.screenLocked = false;
        result.flightPathActive = true;
        result.allowedDomains = allowedDomains;
        result.activeFlightPathName = activeFlightPathName;
        console.log('[Flight Path] Applied authorized domain policy');
        break;
        
      case 'remove-flight-path':
        allowedDomains = []; // Clear all flight path domains
        activeFlightPathName = null; // Clear Flight Path name
        if (!screenLocked) restrictionSsoPassThroughActive = false;
        
        // Clear persisted Flight Path state
        await chrome.storage.local.remove('flightPathState');
        assertCommandExecutionCurrent('flight-path removal persistence');
        console.log('[Flight Path] State cleared from storage');
        
        // Clear network-level blocking rules
        await clearBlockingRules();
        assertCommandExecutionCurrent('flight-path removal rules');
        
        await notifyCommandUi({
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
        assertCommandExecutionCurrent('temporary unblock rules');

        await notifyCommandUi({
          title: 'Temporary Access Granted',
          message: `Your teacher has temporarily unblocked ${tempDomain} for ${tempDuration} minutes.`,
          priority: 1,
        });

        result.domain = tempDomain;
        result.expiresAt = tempExpiresAt;
        result.durationMinutes = tempDuration;
        console.log('[Temp Unblock] Applied bounded exception');
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
        assertCommandExecutionCurrent('teacher block-list rules');

        if (teacherBlockedDomains.length > 0) {
          await notifyCommandUi({
            title: 'Block List Applied',
            message: `Your teacher has blocked: ${teacherBlockedDomains.slice(0, 3).join(', ')}${teacherBlockedDomains.length > 3 ? '...' : ''}`,
            priority: 1,
          });
        }

        result.activeBlockListName = activeBlockListName;
        result.blockedDomains = teacherBlockedDomains;
        console.log('[Block List] Applied teacher-session policy');
        break;

      case 'remove-block-list':
        teacherBlockedDomains = [];
        activeBlockListName = null;

        // Clear teacher block list rules (keeps global blacklist)
        await clearTeacherBlockListRules();
        assertCommandExecutionCurrent('teacher block-list removal');
        
        await notifyCommandUi({
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
        
        await reconcileClassroomStateTabsBestEffort({
          restrictions: classroomRestrictionsFromRuntime(),
        }, {
          authContext: commandAuthContext,
          assertCurrent: assertCommandExecutionCurrent,
          runtimeOwner: executionContext.runtimeOwner,
          tabMutationJournal: commandTabJournal,
        });
        assertCommandExecutionCurrent('tab-limit enforcement');
        
        result.currentMaxTabs = currentMaxTabs;
        console.log('Tab limit set to:', currentMaxTabs);
        break;

      case 'attention-mode':
        // Show/hide attention overlay on all tabs (fire-and-forget for instant response)
        const attentionActive = command.data.active;
        const attentionMessage = command.data.message || 'Please look up!';

        // Update attention mode state (blocks navigation and new tabs when active)
        attentionModeActive = attentionActive;
        await composeDynamicRules(['classroom', 'restrictionSso']);
        assertCommandExecutionCurrent('attention-mode rules');

        // Fire-and-forget - don't await to avoid any delay
        await broadcastCommandUi('attention-mode', {
          active: attentionActive,
          message: attentionMessage,
        });

        if (attentionActive) {
          await notifyCommandUi({
            title: 'Attention Required',
            message: attentionMessage,
            priority: 2,
          });
        }

        result.active = attentionActive;
        result.message = attentionMessage;
        console.log('Attention mode:', attentionActive ? 'ON' : 'OFF');
        break;

      case 'timer':
        const timerAction = command.data.action;
        const timerSeconds = command.data.seconds;
        const timerMessage = command.data.message || '';
        const timerState = await persistTimerOverlay(command, executionContext);
        assertCommandExecutionCurrent('timer persistence');
        const timerEndsAt = timerState?.timer?.endsAt || null;

        await broadcastCommandUi('timer', {
          action: timerAction,
          seconds: timerSeconds,
          message: timerMessage,
          endsAt: timerEndsAt,
          teachingSessionId: timerState?.timer?.teachingSessionId || null,
        });

        if (timerAction === 'start') {
          await notifyCommandUi({
            title: 'Timer Started',
            message: `${Math.floor(timerSeconds / 60)}:${String(timerSeconds % 60).padStart(2, '0')} remaining`,
            priority: 1,
          });
        }

        result.action = timerAction;
        result.seconds = timerSeconds;
        result.message = timerMessage;
        result.endsAt = timerEndsAt;
        console.log('Timer:', safeDiagnosticLabel(timerAction), timerSeconds, 'seconds');
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
          console.log('Poll dedup: already shown');
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
        assertCommandExecutionCurrent('poll persistence');

        await broadcastCommandUi('poll', {
          action: pollAction,
          pollId,
          question: pollQuestion,
          options: pollOptions,
          expiresAt: pollState?.poll?.expiresAt || null,
          teachingSessionId: pollState?.poll?.teachingSessionId || null,
        });

        if (pollAction === 'start') {
          await notifyCommandUi({
            title: 'Poll',
            message: pollQuestion,
            priority: 2,
          });
        }

        result.action = pollAction;
        result.pollId = pollId;
        result.question = pollQuestion;
        console.log('Poll:', safeDiagnosticLabel(pollAction));
        break;

      case 'chat-notification':
        // Show chat notification overlay on all tabs (fire-and-forget for instant response)
        const chatMessage = command.data.message;
        const chatFromName = command.data.fromName;

        // Fire-and-forget - don't await to avoid any delay
        await broadcastCommandUi('chat-notification', {
          message: chatMessage,
          fromName: chatFromName,
        });

        result.messageDelivered = true;
        result.fromName = chatFromName;
        console.log('Chat notification sent');
        break;

      case 'hand-dismissed':
        // Notify student their hand was acknowledged
        await updateLocalFabHandRaised(false, 'hand-dismissed');
        assertCommandExecutionCurrent('hand dismissal');

        // Fire-and-forget - don't await to avoid any delay
        await broadcastCommandUi('hand-dismissed', command.data || {});

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
        assertCommandExecutionCurrent('messaging toggle');

        // Fire-and-forget - don't await to avoid any delay
        await broadcastCommandUi('messaging-toggle', {
          ...(command.data || {}),
          enabled: messagingEnabled,
        });

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
        assertCommandExecutionCurrent('hand-raising toggle');

        // Fire-and-forget - don't await to avoid any delay
        await broadcastCommandUi('hand-raising-toggle', {
          ...(command.data || {}),
          enabled: handRaisingEnabled,
        });

        result.handRaisingEnabled = handRaisingEnabled;
        console.log('Hand raising toggle sent:', handRaisingEnabled);
        break;

      case 'fab-state-sync':
      case 'fab-state':
        // Apply session lifecycle state pushed by SchoolPilot when classes start/end.
        const fabStateData = command.data || {};
        const appliedFabState = await applyFabSettings(fabStateData);
        assertCommandExecutionCurrent('FAB state command');

        result.fabState = appliedFabState;
        console.log('FAB state updated');
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
            studentId: commandAuthContext.studentId,
            studentSessionId: commandAuthContext.studentSessionId,
          }, {
            authContext: commandAuthContext,
            authorityEnvelope: commandSourceMessage,
          });
          assertCommandExecutionCurrent('student sign-out FAB cleanup');
          // clearStudentAuth owns and serializes FAB/chat/inbox deletion. An
          // independent storage write could otherwise land after a newer
          // identity commits and wipe that student's hydrated UI.
          await clearStudentAuth(signOutReason, {
            notifyBackend: false,
            serverSessionEnded: true,
            pauseAutoRegistration: true,
            disconnectWebSocket: false,
            expectedAuthContext: commandAuthContext,
          });
          result.signedOut = true;
          result.reason = signOutReason;
          result.sessionId = command.data.sessionId || null;
          console.log('[Sign Out] Teacher-forced student sign-out applied');
        }
        break;

      default:
        throw new Error(`Unsupported remote control command: ${command.type || 'unknown'}`);
    }

  assertCommandExecutionCurrent('remote-control result');
  const state = await getClassroomCommandStateSnapshot();
  assertCommandExecutionCurrent('remote-control result');
  return {
    ...result,
    state,
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
  removeStudentAuthGatePresenceSourcesForTab(tabId);
});

// Unbound delivery is reserved for identity-clearing messages whose only side
// effect is removing retired UI. Student-targeted content always uses the
// immutable authentication-context path below.
async function broadcastToAllTabsUnbound(messageType, messageData) {
  const tabs = await chrome.tabs.query({});
  const validTabs = tabs.filter(tab =>
    tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')
  );

  // Identity clearing must settle before a replacement identity replays its
  // exact UI snapshot. Otherwise a delayed injection retry for student A can
  // erase student B's newly rendered state.
  await Promise.all(validTabs.map(async (tab) => {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: messageType,
        data: messageData,
      });
    } catch {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
        injectedTabs.add(tab.id);
        await chrome.tabs.sendMessage(tab.id, {
          type: messageType,
          data: messageData,
        });
      } catch {
        // Unsupported/internal pages and tabs that close during cleanup are
        // best effort. The target-context guard in content.js is authoritative.
      }
    }
  }));
}

async function broadcastToAllTabs(messageType, messageData) {
  if (messageType === 'student-message-state-cleared') {
    return broadcastToAllTabsUnbound(messageType, messageData);
  }
  let authContext;
  try {
    authContext = captureAuthenticatedContext(`student UI broadcast:${messageType}`);
    return await broadcastToAllTabsForAuth(
      messageType,
      messageData,
      authContext,
      {
        studentId: authContext.studentId,
        studentSessionId: authContext.studentSessionId,
      },
    );
  } catch (error) {
    if (!isAuthContextCancellation(error)) {
      console.warn('[Student UI] Broadcast skipped:', safeDiagnosticError(error));
    }
    return false;
  }
}

function studentMessageContextFor(authContext) {
  return Object.freeze({
    authContextId: authContext.authContextId,
    schoolId: authContext.schoolId,
    studentId: authContext.studentId,
    studentSessionId: authContext.studentSessionId,
  });
}

function capturePendingAuthenticatedContext(reason, mutationGeneration) {
  if (
    !studentAuthCommitPending
    || studentAuthCommitPendingGeneration !== mutationGeneration
    || activeAuthContextGeneration !== mutationGeneration
  ) throw authContextSuperseded(reason);
  const serverOrigin = normalizedServerOrigin(CONFIG.serverUrl);
  const authContextId = String(CONFIG.authContextId || '').trim();
  if (!serverOrigin || !authContextId || ![
    CONFIG.deviceId,
    CONFIG.studentToken,
    CONFIG.activeStudentId,
    CONFIG.activeStudentSessionId,
  ].every((value) => typeof value === 'string' && value.trim())) {
    throw authContextSuperseded(reason);
  }
  return Object.freeze({
    authContextId,
    mutationGeneration,
    serverOrigin,
    schoolId: String(CONFIG.schoolId || '').trim() || null,
    deviceId: CONFIG.deviceId,
    studentId: CONFIG.activeStudentId,
    studentSessionId: CONFIG.activeStudentSessionId,
    studentToken: CONFIG.studentToken,
    studentEmail: CONFIG.studentEmail || '',
    signal: authContextAbortController.signal,
    allowCommitPending: true,
  });
}

function studentMessageContextIsCurrent(value) {
  try {
    const authContext = captureAuthenticatedContext('student message receiver validation');
    return Boolean(
      value
      && value.authContextId === authContext.authContextId
      && value.schoolId === authContext.schoolId
      && value.studentId === authContext.studentId
      && value.studentSessionId === authContext.studentSessionId
    );
  } catch {
    return false;
  }
}

function captureStudentActionRequest(message, reason = 'student action') {
  const authContext = captureAuthenticatedContext(reason);
  const expectedContext = studentMessageContextFor(authContext);
  const suppliedContext = message?.studentMessageContext;
  if (
    !suppliedContext
    || suppliedContext.authContextId !== expectedContext.authContextId
    || suppliedContext.schoolId !== expectedContext.schoolId
    || suppliedContext.studentId !== expectedContext.studentId
    || suppliedContext.studentSessionId !== expectedContext.studentSessionId
  ) throw authContextSuperseded(reason);
  const expectedFabBinding = fabIdentityBinding();
  if (!expectedFabBinding || message?.fabBinding !== expectedFabBinding) {
    throw authContextSuperseded(reason);
  }
  const sessionId = String(message?.sessionId || '').trim();
  if (!sessionId || !activeTeachingSessionIds().includes(sessionId)) {
    const error = new Error('Student action has no exact active teaching session');
    error.code = 'STUDENT_CHAT_SESSION_REQUIRED';
    throw error;
  }
  return Object.freeze({ authContext, fabBinding: expectedFabBinding, sessionId });
}

function captureStudentIdentityRequest(message, reason = 'student identity action') {
  const authContext = captureAuthenticatedContext(reason);
  const expectedContext = studentMessageContextFor(authContext);
  const suppliedContext = message?.studentMessageContext;
  if (
    !suppliedContext
    || suppliedContext.authContextId !== expectedContext.authContextId
    || suppliedContext.schoolId !== expectedContext.schoolId
    || suppliedContext.studentId !== expectedContext.studentId
    || suppliedContext.studentSessionId !== expectedContext.studentSessionId
  ) throw authContextSuperseded(reason);
  return Object.freeze({ authContext });
}

function assertStudentActionRequestCurrent(request, reason = 'student action') {
  assertAuthenticatedContextCurrent(request.authContext, reason);
  if (
    request.fabBinding !== fabIdentityBinding()
    || !activeTeachingSessionIds().includes(request.sessionId)
  ) throw authContextSuperseded(reason);
}

async function notifyTeacherMessageForAuth(opts, authContext, sourceMessage, messageId) {
  const notificationPrefix = authBoundNotificationPrefixForContext(authContext);
  if (!notificationPrefix) throw authContextSuperseded('teacher message notification');
  const notificationId = `${notificationPrefix}${String(messageId || 'message')}`
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 240);
  const assertCurrent = (reason = 'teacher message notification') => {
    assertAuthenticatedContextCurrent(authContext, reason);
    const binding = assertCurrentStudentBinding(sourceMessage, reason, { authContext });
    assertBindingMatchesAuthContext(binding, authContext, reason);
  };
  assertCurrent();
  const inventoryReady = await ensureAuthBoundNotificationInventory();
  if (!inventoryReady) {
    const error = new Error('Teacher notification identity inventory is unavailable');
    error.code = 'AUTH_BOUND_NOTIFICATION_UNVERIFIED';
    throw error;
  }
  assertCurrent();
  activeAuthBoundNotificationIds.add(notificationId);
  try {
    await safeNotify({ ...opts, notificationId });
    assertCurrent();
  } catch (error) {
    const cleared = await clearAuthBoundNotification(notificationId).catch(() => false);
    activeAuthBoundNotificationIds.delete(notificationId);
    if (!cleared) {
      authBoundNotificationInventoryReconciled = false;
      authBoundNotificationCleanupRetryAt = 0;
      await clearAllAuthBoundTeacherMessageNotifications().catch(() => false);
    }
    throw error;
  }
  return notificationId;
}

async function broadcastToAllTabsForAuth(
  messageType,
  messageData,
  authContext,
  sourceMessage,
  transport = {},
) {
  const assertCurrent = (reason = 'teacher message broadcast') => {
    assertAuthenticatedContextCurrent(authContext, reason);
    const binding = assertCurrentStudentBinding(sourceMessage, reason, { authContext });
    assertBindingMatchesAuthContext(binding, authContext, reason);
  };
  assertCurrent();
  const queryTabs = transport.queryTabs || (() => chrome.tabs.query({}));
  const sendTabMessage = transport.sendMessage
    || ((tabId, payload) => chrome.tabs.sendMessage(tabId, payload));
  const injectContentScript = transport.executeScript
    || ((details) => chrome.scripting.executeScript(details));
  const tabs = await queryTabs();
  assertCurrent();
  const validTabs = tabs.filter((tab) => (
    tab.url
    && !tab.url.startsWith('chrome://')
    && !tab.url.startsWith('chrome-extension://')
  ));
  const messageContext = studentMessageContextFor(authContext);
  for (const tab of validTabs) {
    assertCurrent();
    try {
      await sendTabMessage(tab.id, {
        type: messageType,
        data: messageData,
        studentMessageContext: messageContext,
      });
      assertCurrent();
    } catch (error) {
      assertCurrent();
      try {
        await injectContentScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
        assertCurrent();
        injectedTabs.add(tab.id);
        await sendTabMessage(tab.id, {
          type: messageType,
          data: messageData,
          studentMessageContext: messageContext,
        });
        assertCurrent();
      } catch (retryError) {
        assertCurrent();
        if (isAuthContextCancellation(retryError)) throw retryError;
      }
    }
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

async function handleChatMessage(message, options = {}) {
  console.log('[Chat] Exact-bound teacher message received');
  const authContext = options.authContext
    || captureAuthenticatedContext('teacher chat message');
  assertAuthenticatedContextCurrent(authContext, 'teacher chat message');
  const commandBinding = assertCurrentStudentBinding(
    message,
    'teacher chat message',
    { authContext },
  );
  assertBindingMatchesAuthContext(commandBinding, authContext, 'teacher chat message');

  if (!messageMatchesActiveFabSession(message)) {
    console.warn('[FAB] Ignoring chat for an inactive teaching session');
    return;
  }

  const expectedBinding = monitoringEventAuthBindingForContext(authContext);
  const inboxMessage = messageWithStableLocalId(message, 'chat');
  const inboxResult = await persistTeacherMessages([inboxMessage], {
    reason: 'websocket-chat',
    expectedBinding,
    authContext,
    sourceMessage: message,
  });
  assertAuthenticatedContextCurrent(authContext, 'teacher chat message persistence');
  assertCurrentStudentBinding(message, 'teacher chat message persistence', { authContext });
  if (!inboxResult.addedMessageIds.includes(inboxMessage.id)) {
    console.log('Dedup: skipping duplicate chat message');
    return;
  }

  // Show browser notification immediately (fastest feedback)
  assertAuthenticatedContextCurrent(authContext, 'teacher chat notification');
  await notifyTeacherMessageForAuth({
    title: `Message from ${inboxMessage.fromName || 'Teacher'}`,
    message: inboxMessage.message,
    priority: 2,
    requireInteraction: false,
  }, authContext, message, inboxMessage.id);
  assertAuthenticatedContextCurrent(authContext, 'teacher chat notification');
  assertCurrentStudentBinding(message, 'teacher chat notification', { authContext });

  // Fire-and-forget broadcast to all tabs for instant delivery
  await broadcastToAllTabsForAuth('show-message', {
    id: inboxMessage.id,
    message: inboxMessage.message,
    fromName: inboxMessage.fromName || 'Teacher',
    timestamp: inboxMessage.timestamp || Date.now(),
  }, authContext, message);
  assertAuthenticatedContextCurrent(authContext, 'teacher chat broadcast');
}

async function handleDurableTeacherMessage(message, options = {}) {
  let expectedBinding = options.expectedBinding || null;
  const commandId = getCommandIdFromMessage(message);
  let authContext = null;
  let commandBinding = null;
  const hasChatDelivery = !commandId || Boolean(message.chatDeliveryId || message.deliveryId);
  const delivery = RuntimeCore.commandDeliveryState(
    { type: 'teacher-message', ...message.command },
    message,
    Date.now()
  );
  try {
    authContext = options.authContext || captureAuthenticatedContext('durable teacher message');
    assertAuthenticatedContextCurrent(authContext, 'durable teacher message');
    const authBinding = monitoringEventAuthBindingForContext(authContext);
    if (expectedBinding && expectedBinding !== authBinding) {
      throw authContextSuperseded('durable teacher message');
    }
    expectedBinding = authBinding;
    commandBinding = assertCurrentStudentBinding(message, 'durable teacher message');
    assertBindingMatchesAuthContext(commandBinding, authContext, 'durable teacher message');
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
    assertAuthenticatedContextCurrent(authContext, 'durable teacher message');
    assertCurrentStudentBinding(message, 'durable teacher message');
    const inboxMessage = messageWithStableLocalId(message, 'teacher-message');
    const inboxResult = await persistTeacherMessages([inboxMessage], {
      reason: 'websocket-teacher-message',
      expectedBinding,
      authContext,
      sourceMessage: message,
    });
    assertAuthenticatedContextCurrent(authContext, 'durable teacher message persistence');
    assertCurrentStudentBinding(message, 'durable teacher message persistence', { authContext });
    const deduplicated = !inboxResult.addedMessageIds.includes(inboxMessage.id);

    if (commandId) {
      assertAuthenticatedContextCurrent(authContext, 'durable teacher message received acknowledgement');
      await sendCommandAck(commandId, 'received', {
        authContext,
        binding: commandBinding,
        commandType: 'teacher-message',
        deliveryPolicy: delivery.deliveryPolicy,
        expiresAt: delivery.expiresAt,
      });
      assertAuthenticatedContextCurrent(authContext, 'durable teacher message received acknowledgement');
      assertCurrentStudentBinding(message, 'durable teacher message received acknowledgement', { authContext });
    }

    if (deduplicated) {
      console.log('Dedup: skipping duplicate teacher-message');
    } else {
      assertAuthenticatedContextCurrent(authContext, 'durable teacher message notification');
      await notifyTeacherMessageForAuth({
        title: 'Reply from Teacher',
        message: inboxMessage.message || 'New message',
        priority: 2,
        requireInteraction: false,
      }, authContext, message, inboxMessage.id);
      assertAuthenticatedContextCurrent(authContext, 'durable teacher message notification');
      assertCurrentStudentBinding(message, 'durable teacher message notification', { authContext });
      await broadcastToAllTabsForAuth('chat-reply', {
        _msgId: inboxMessage.id,
        chatMessageId: message.chatMessageId || message.messageId || inboxMessage.id,
        messageId: message.chatMessageId || message.messageId || inboxMessage.id,
        sessionId: message.sessionId,
        studentId: message.studentId,
        message: inboxMessage.message,
        fromName: inboxMessage.fromName || 'Teacher',
        timestamp: inboxMessage.timestamp || Date.now(),
      }, authContext, message);
      assertAuthenticatedContextCurrent(authContext, 'durable teacher message broadcast');
    }

    if (hasChatDelivery) {
      assertAuthenticatedContextCurrent(authContext, 'teacher chat delivery acknowledgement');
      try {
        await sendChatDeliveryAck(message, 'delivered', null, authContext);
      } catch (error) {
        if (isAuthContextCancellation(error)) throw error;
        console.warn('[Chat ACK] Could not persist delivered acknowledgement:', safeDiagnosticError(error));
      }
      assertAuthenticatedContextCurrent(authContext, 'teacher chat delivery acknowledgement');
      assertCurrentStudentBinding(message, 'teacher chat delivery acknowledgement', { authContext });
    }
    if (commandId) {
      assertAuthenticatedContextCurrent(authContext, 'durable teacher message completed state');
      const commandState = await getClassroomCommandStateSnapshot();
      assertAuthenticatedContextCurrent(authContext, 'durable teacher message completed state');
      assertCurrentStudentBinding(message, 'durable teacher message completed state', { authContext });
      await sendCommandAck(commandId, 'completed', {
        authContext,
        binding: commandBinding,
        commandType: 'teacher-message',
        result: deduplicated
          ? { deduplicated: true }
          : {
              delivered: true,
              messageLength: String(inboxMessage.message || '').length,
            },
        state: commandState,
        deliveryPolicy: delivery.deliveryPolicy,
        expiresAt: delivery.expiresAt,
      });
      assertAuthenticatedContextCurrent(authContext, 'durable teacher message completed acknowledgement');
      assertCurrentStudentBinding(message, 'durable teacher message completed acknowledgement', { authContext });
    }
    return { messageId: inboxMessage.id, deduplicated };
  } catch (error) {
    if (hasChatDelivery && authContext && commandBinding && !isAuthContextCancellation(error)) {
      await sendChatDeliveryAck(
        message,
        'failed',
        commandErrorMessage(error),
        authContext,
      ).catch(() => {});
    }
    if (
      commandId
      && authContext
      && commandBinding
      && !isAuthContextCancellation(error)
      && error?.code !== 'STUDENT_BINDING_MISMATCH'
    ) {
      await sendCommandAck(commandId, 'failed', {
        authContext,
        binding: commandBinding,
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

async function handleHeartbeatPendingMessages(rawMessages, expectedBinding, authContext = null) {
  const operationAuthContext = authContext
    || captureAuthenticatedContext('heartbeat teacher messages');
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
      }, { expectedBinding, authContext: operationAuthContext });
      if (!result.deduplicated) addedMessageIds.push(result.messageId);
    } catch (error) {
      console.warn('[Heartbeat] Durable teacher message was not applied:', safeDiagnosticError(error));
    }
  }

  if (legacyMessages.length > 0) {
    const legacyResult = await persistHeartbeatPendingMessages(legacyMessages, expectedBinding, {
      authContext: operationAuthContext,
      // Heartbeat rows are already authenticated as a batch. Each durable row
      // above supplies its own exact envelope; legacy rows are fenced to the
      // immutable response context and local inbox binding.
    });
    addedMessageIds.push(...legacyResult.addedMessageIds);
  }
  return { addedMessageIds };
}

// Check-in Request Handler (Phase 3)
function handleCheckInRequest(request, options = {}) {
  const authContext = options.authContext
    || captureAuthenticatedContext('teacher check-in');
  return enqueueStudentAuthMutation(() => handleCheckInRequestNow(request, {
    ...options,
    authContext,
  }));
}

async function handleCheckInRequestNow(request, options = {}) {
  console.log('Check-in request received');
  const authContext = options.authContext
    || captureAuthenticatedContext('teacher check-in');
  const assertCurrent = (reason = 'teacher check-in') => {
    assertAuthenticatedContextCurrent(authContext, reason);
    const binding = assertCurrentStudentBinding(request, reason, { authContext });
    assertBindingMatchesAuthContext(binding, authContext, reason);
  };
  assertCurrent();
  const now = Date.now();
  const expiresAt = Math.min(
    Number(request.expiresAt || now + PENDING_CHECK_IN_MAX_AGE_MS),
    now + PENDING_CHECK_IN_MAX_AGE_MS,
  );
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  const binding = monitoringEventAuthBindingForContext(authContext);
  await notifyTeacherMessageForAuth({
    title: 'Teacher Check-in',
    message: String(request.question || '').slice(0, 500),
    priority: 2,
    requireInteraction: true,
  }, authContext, request, request.requestId || request._msgId || 'check-in');
  assertCurrent();
  await durableLocalKv.set({
    [PENDING_CHECK_IN_KEY]: {
      question: String(request.question || '').slice(0, 500),
      options: (Array.isArray(request.options) ? request.options : [])
        .slice(0, 20)
        .map((option) => String(option).slice(0, 200)),
      timestamp: now,
      expiresAt,
      binding,
    },
  });
  try {
    assertCurrent();
  } catch (error) {
    const stored = await durableLocalKv.get(PENDING_CHECK_IN_KEY);
    if (stored[PENDING_CHECK_IN_KEY]?.binding === binding) {
      await durableLocalKv.remove(PENDING_CHECK_IN_KEY);
    }
    throw error;
  }
  chrome.alarms.create(PENDING_CHECK_IN_EXPIRY_ALARM, { when: expiresAt + 1 });
  return true;
}

function pendingCheckInOwnerMatches(left, right) {
  return Boolean(left && right)
    && left.binding === right.binding
    && Number(left.timestamp || 0) === Number(right.timestamp || 0)
    && Number(left.expiresAt || 0) === Number(right.expiresAt || 0);
}

function expirePendingCheckIn(alarm = {}, options = {}) {
  const nowValue = Number(options.now ?? Date.now());
  return enqueueStudentAuthMutation(async () => {
    const stored = await durableLocalKv.get(PENDING_CHECK_IN_KEY);
    const pending = stored[PENDING_CHECK_IN_KEY];
    if (!pending) {
      await chrome.alarms.clear(PENDING_CHECK_IN_EXPIRY_ALARM);
      return false;
    }
    const expiresAt = Number(pending.expiresAt || 0);
    const scheduledTime = Number(alarm?.scheduledTime || 0);
    if (
      !Number.isFinite(expiresAt)
      || expiresAt <= 0
      || expiresAt > nowValue
      || (scheduledTime > 0 && scheduledTime + 1 < expiresAt)
    ) {
      if (Number.isFinite(expiresAt) && expiresAt > nowValue) {
        chrome.alarms.create(PENDING_CHECK_IN_EXPIRY_ALARM, { when: expiresAt + 1 });
      } else if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
        const latest = await durableLocalKv.get(PENDING_CHECK_IN_KEY);
        if (pendingCheckInOwnerMatches(pending, latest[PENDING_CHECK_IN_KEY])) {
          await durableLocalKv.remove(PENDING_CHECK_IN_KEY);
        }
        const remaining = (await durableLocalKv.get(PENDING_CHECK_IN_KEY))[PENDING_CHECK_IN_KEY];
        if (remaining && Number(remaining.expiresAt || 0) > nowValue) {
          chrome.alarms.create(PENDING_CHECK_IN_EXPIRY_ALARM, {
            when: Number(remaining.expiresAt) + 1,
          });
        } else {
          await chrome.alarms.clear(PENDING_CHECK_IN_EXPIRY_ALARM);
        }
        return !remaining;
      }
      return false;
    }

    // Re-read the exact row immediately before deleting. Check-in writers and
    // auth adoption use the same mutation queue, so a stale A expiry can never
    // remove or clear the alarm for a newer B prompt.
    const latest = await durableLocalKv.get(PENDING_CHECK_IN_KEY);
    if (pendingCheckInOwnerMatches(pending, latest[PENDING_CHECK_IN_KEY])) {
      await durableLocalKv.remove(PENDING_CHECK_IN_KEY);
    }
    const remaining = (await durableLocalKv.get(PENDING_CHECK_IN_KEY))[PENDING_CHECK_IN_KEY];
    if (remaining && Number(remaining.expiresAt || 0) > nowValue) {
      chrome.alarms.create(PENDING_CHECK_IN_EXPIRY_ALARM, {
        when: Number(remaining.expiresAt) + 1,
      });
    } else {
      await chrome.alarms.clear(PENDING_CHECK_IN_EXPIRY_ALARM);
    }
    return !remaining;
  });
}

function browserPolicyEnvelopeForAuth(authContext) {
  return {
    studentId: authContext.studentId,
    studentSessionId: authContext.studentSessionId,
  };
}

async function recordNavigationBlockedForAuth(authContext, url, policySource) {
  assertAuthenticatedContextCurrent(authContext, 'navigation policy telemetry');
  await enqueueMonitoringEvent('navigation_blocked', {
    url,
    title: '',
    policySource,
  }, { authContext });
  assertAuthenticatedContextCurrent(authContext, 'navigation policy telemetry');
}

async function notifyNavigationBlockedForAuth(authContext, notification, policySource) {
  assertAuthenticatedContextCurrent(authContext, 'navigation policy notification');
  await notifyTeacherMessageForAuth(
    notification,
    authContext,
    browserPolicyEnvelopeForAuth(authContext),
    `navigation-${policySource}`,
  );
  assertAuthenticatedContextCurrent(authContext, 'navigation policy notification');
}

async function goBackOrBlankForAuth(tabId, authContext, reason) {
  assertAuthenticatedContextCurrent(authContext, reason);
  try {
    await chrome.tabs.goBack(tabId);
    assertAuthenticatedContextCurrent(authContext, reason);
  } catch (error) {
    if (isAuthContextCancellation(error)) {
      await chrome.tabs.remove(tabId).catch(() => {});
      throw error;
    }
    assertAuthenticatedContextCurrent(authContext, reason);
    try {
      await chrome.tabs.update(tabId, { url: 'about:blank' });
      assertAuthenticatedContextCurrent(authContext, reason);
    } catch (fallbackError) {
      if (isAuthContextCancellation(fallbackError)) {
        await chrome.tabs.remove(tabId).catch(() => {});
      }
      throw fallbackError;
    }
  }
}

async function updateTabForAuth(tabId, updateProperties, authContext, reason) {
  assertAuthenticatedContextCurrent(authContext, reason);
  try {
    const updated = await chrome.tabs.update(tabId, updateProperties);
    assertAuthenticatedContextCurrent(authContext, reason);
    return updated;
  } catch (error) {
    if (isAuthContextCancellation(error)) {
      await chrome.tabs.remove(tabId).catch(() => {});
    }
    throw error;
  }
}

async function removeTabForAuth(tabId, authContext, reason) {
  assertAuthenticatedContextCurrent(authContext, reason);
  await chrome.tabs.remove(tabId);
  assertAuthenticatedContextCurrent(authContext, reason);
}

function tabLimitTargetMatches(captured, current) {
  return Number.isInteger(captured?.id)
    && current?.id === captured.id
    && Number(current?.windowId) === Number(captured.windowId)
    && String(current?.url || '') === String(captured.url || '')
    && String(current?.pendingUrl || '') === String(captured.pendingUrl || '');
}

async function applyWebSocketTabLimitSetting(message, authContext, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(message?.settings || {}, 'maxTabsPerStudent')) {
    return { applied: false, limit: currentMaxTabs, closed: 0 };
  }
  const queryTabs = options.queryTabs || ((query) => chrome.tabs.query(query));
  const getTab = options.getTab || ((tabId) => chrome.tabs.get(tabId));
  const removeTab = options.removeTab || ((tabId) => chrome.tabs.remove(tabId));
  const notify = options.notify || ((notification, expectedAuthContext, sourceMessage, messageId) => (
    notifyTeacherMessageForAuth(notification, expectedAuthContext, sourceMessage, messageId)
  ));

  // Tab enumeration and destructive enforcement share the authentication
  // mutation queue with identity adoption. Chrome tab removal is not
  // abortable, so the remove invocation is the linearization point: a new
  // identity may reserve its generation, but cannot commit CONFIG/auth state
  // until all already-authorized A targets have settled and this operation
  // has observed the retirement fence.
  return enqueueStudentAuthMutation(async () => {
    const reason = 'WebSocket tab-limit enforcement';
    assertAuthenticatedContextCurrent(authContext, reason);
    assertCurrentStudentBinding(message, reason, { authContext });
    const parsedLimit = Number(message.settings.maxTabsPerStudent);
    schoolMaxTabs = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 1000)
      : null;
    currentMaxTabs = effectiveTabLimit();
    const appliedLimit = currentMaxTabs;
    console.log('Applied tab limit from settings:', appliedLimit === null ? 'unlimited' : appliedLimit);
    if (appliedLimit === null || appliedLimit <= 0) {
      return { applied: true, limit: appliedLimit, closed: 0 };
    }

    const tabs = await queryTabs({});
    assertAuthenticatedContextCurrent(authContext, 'WebSocket tab-limit query');
    assertCurrentStudentBinding(message, 'WebSocket tab-limit query', { authContext });
    if (!Array.isArray(tabs) || tabs.length <= appliedLimit) {
      return { applied: true, limit: appliedLimit, closed: 0 };
    }

    const foregroundTabs = await queryTabs({ active: true, lastFocusedWindow: true });
    assertAuthenticatedContextCurrent(authContext, 'WebSocket tab-limit foreground query');
    assertCurrentStudentBinding(message, 'WebSocket tab-limit foreground query', { authContext });
    const foregroundTab = Array.isArray(foregroundTabs)
      ? foregroundTabs.find((tab) => Number.isInteger(tab?.id) && tab.active === true)
      : null;
    const preserveTabIds = restrictionSsoTabLimitPreserveIds(tabs, {
      foregroundTabId: foregroundTab?.id,
    });
    const removalIds = RuntimeCore.planTabLimitRemovals({
      restrictions: classroomRestrictionsFromRuntime(),
    }, tabs, {
      maxTabs: appliedLimit,
      foregroundTabId: foregroundTab?.id,
      preserveTabIds,
    });
    const byId = new Map(tabs.map((tab) => [tab?.id, tab]));
    const targets = removalIds.map((tabId) => byId.get(tabId)).filter(Boolean).map((tab) => Object.freeze({
      id: tab?.id,
      windowId: tab?.windowId,
      url: String(tab?.url || ''),
      pendingUrl: String(tab?.pendingUrl || ''),
    }));
    let closed = 0;
    for (const target of targets) {
      if (!Number.isInteger(target.id) || target.url.startsWith('chrome://')) continue;
      try {
        assertAuthenticatedContextCurrent(authContext, 'WebSocket tab-limit target check');
        const current = await getTab(target.id);
        assertAuthenticatedContextCurrent(authContext, 'WebSocket tab-limit target check');
        assertCurrentStudentBinding(message, 'WebSocket tab-limit target check', { authContext });
        if (!tabLimitTargetMatches(target, current)) continue;
        await removeTab(target.id);
        assertAuthenticatedContextCurrent(authContext, 'WebSocket tab-limit close');
        assertCurrentStudentBinding(message, 'WebSocket tab-limit close', { authContext });
        closed += 1;
      } catch (tabError) {
        if (isAuthContextCancellation(tabError)) throw tabError;
        console.warn('Failed to close an excess tab:', safeDiagnosticError(tabError));
      }
    }

    if (closed > 0) {
      await notify({
        title: 'Tab Limit Enforced',
        message: `Your teacher has set a limit of ${appliedLimit} tab${appliedLimit === 1 ? '' : 's'}. Extra tabs have been closed.`,
        priority: 1,
      }, authContext, message, `tab-limit-${appliedLimit}`);
      assertAuthenticatedContextCurrent(authContext, 'WebSocket tab-limit notification');
      assertCurrentStudentBinding(message, 'WebSocket tab-limit notification', { authContext });
    }
    return { applied: true, limit: appliedLimit, closed };
  });
}

// Prevent navigation when screen is locked (domain-based blocking)
async function handleBeforeNavigateForPolicy(details) {
  if (details.frameId !== 0) return;
  let eventAuthContext;
  try {
    eventAuthContext = captureAuthenticatedContext('navigation policy event');
  } catch {
    return;
  }
  try {
    await classroomStateRestorePromise;
    await enqueueStudentAuthMutation(async () => {
      assertAuthenticatedContextCurrent(eventAuthContext, 'navigation policy event');
      if (details.url.startsWith('chrome://') || details.url.startsWith('about:')) return;
      const targetDomain = extractDomain(details.url);
      if (!targetDomain) return;

      if (temporaryAllowedDomains.some((item) => item.expiresAt <= Date.now())) {
        await enqueueClassroomStateOperation(() => checkClassroomStateExpiryNow({
          authContext: eventAuthContext,
        }));
        assertAuthenticatedContextCurrent(eventAuthContext, 'navigation policy expiry');
      }

      const policy = {
        attentionModeActive,
        globalBlockedDomains: [...globalBlockedDomains],
        screenLocked,
        lockedDomain,
        lockedUrl,
        temporaryAllowedDomains: temporaryAllowedDomains.map((item) => ({ ...item })),
        teacherBlockedDomains: [...teacherBlockedDomains],
        allowedDomains: [...allowedDomains],
        restrictionSsoPassThroughActive,
      };
      let policySource = null;
      let notification = null;
      let action = 'back';

      if (policy.attentionModeActive) {
        policySource = 'attention_mode';
      } else if (policy.globalBlockedDomains.some((domain) => {
        const normalized = domain.replace(/^www\./, '');
        return targetDomain === normalized || targetDomain.endsWith(`.${normalized}`);
      })) {
        policySource = 'school';
        notification = {
          title: 'Website Blocked',
          message: `Access to ${targetDomain} is blocked by your school.`,
          priority: 2,
        };
      } else if (
        policy.restrictionSsoPassThroughActive
        && normalizedRestrictionSsoHost(details.url)
      ) {
        const teacherBlocked = policy.teacherBlockedDomains.some((domain) => {
          const normalized = domain.replace(/^www\./, '');
          return targetDomain === normalized || targetDomain.endsWith(`.${normalized}`);
        });
        if (!teacherBlocked) return;
        policySource = 'teacher';
        notification = {
          title: 'Website Blocked',
          message: `Access to ${targetDomain} is blocked by your teacher.`,
          priority: 2,
        };
      } else if (policy.screenLocked) {
        if (policy.lockedDomain && isOnSameDomain(details.url, policy.lockedDomain)) return;
        policySource = 'screen_lock';
        action = policy.lockedUrl ? 'locked_url' : 'back';
        notification = {
          title: 'Navigation Blocked',
          message: policy.lockedDomain
            ? `You can only browse within ${policy.lockedDomain}`
            : 'Your screen is locked by your teacher.',
          priority: 2,
        };
      } else {
        const temporarilyAllowed = policy.temporaryAllowedDomains.some((item) => {
          const normalized = item.domain.replace(/^www\./, '');
          return targetDomain === normalized || targetDomain.endsWith(`.${normalized}`);
        });
        if (temporarilyAllowed) return;
        if (policy.teacherBlockedDomains.some((domain) => {
          const normalized = domain.replace(/^www\./, '');
          return targetDomain === normalized || targetDomain.endsWith(`.${normalized}`);
        })) {
          policySource = 'teacher';
          notification = {
            title: 'Website Blocked',
            message: `Access to ${targetDomain} is blocked by your teacher.`,
            priority: 2,
          };
        } else if (
          policy.allowedDomains.length > 0
          && !policy.allowedDomains.some((domain) => isOnSameDomain(details.url, domain))
        ) {
          policySource = 'flight_path';
          action = policy.lockedUrl ? 'locked_url' : 'back';
          notification = {
            title: 'Navigation Blocked',
            message: `You can only access: ${policy.allowedDomains.join(', ')}`,
            priority: 1,
          };
        }
      }

      if (!policySource) return;
      await recordNavigationBlockedForAuth(eventAuthContext, details.url, policySource);
      if (action === 'locked_url') {
        await updateTabForAuth(
          details.tabId,
          { url: policy.lockedUrl },
          eventAuthContext,
          'navigation policy redirect',
        );
      } else {
        await goBackOrBlankForAuth(
          details.tabId,
          eventAuthContext,
          'navigation policy back',
        );
      }
      if (notification) {
        await notifyNavigationBlockedForAuth(
          eventAuthContext,
          notification,
          policySource,
        );
      }
    });
  } catch (error) {
    if (isAuthContextCancellation(error)) return;
    console.warn('[Service Worker] Navigation handler error:', safeDiagnosticError(error));
  }
}
chrome.webNavigation.onBeforeNavigate.addListener(handleBeforeNavigateForPolicy);

// Track navigation commits for instant URL updates (fires immediately when navigation commits)
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  let eventAuthContext;
  try {
    eventAuthContext = captureAuthenticatedContext('navigation committed event');
  } catch {
    return;
  }
  try {
    await classroomStateRestorePromise;
    assertAuthenticatedContextCurrent(eventAuthContext, 'navigation committed event');
    await observeRestrictionSsoHostForAuth(details.url, eventAuthContext).catch((error) => {
      if (!isAuthContextCancellation(error)) {
        console.warn('[Restriction SSO] Visit persistence deferred:', safeDiagnosticError(error));
      }
    });
    assertAuthenticatedContextCurrent(eventAuthContext, 'navigation committed event');
    if (isHttpUrl(details.url)) {
      enforceAuthGateForTab(details.tabId).catch(() => {});
    }
    if (trackingState === TRACKING_STATES.OFF) return;

    // Skip Chrome internal pages
    if (!details.url.startsWith('http')) return;

    // Send immediate heartbeat - this fires the moment navigation commits
    // (before page is loaded, so teacher sees URL change instantly)
    assertAuthenticatedContextCurrent(eventAuthContext, 'navigation committed event');
    scheduleEventHeartbeat('navigation-committed');
  } catch (error) {
    if (isAuthContextCancellation(error)) return;
    console.warn('[Service Worker] Navigation committed handler error:', safeDiagnosticError(error));
  }
});

function restrictionDestinationTab(tab) {
  const url = tab?.pendingUrl || tab?.url || '';
  if (!/^https?:\/\//i.test(url) || RuntimeCore.isRestrictionSsoTab(tab)) return false;
  if (screenLocked && lockedDomain) return isOnSameDomain(url, lockedDomain);
  return allowedDomains.some((domain) => isOnSameDomain(url, domain));
}

function restrictionSsoTabLimitPreserveIds(tabs, options = {}) {
  if (!restrictionSsoPassThroughActive) return [];
  const destination = tabs.find(restrictionDestinationTab) || null;
  const ssoTabs = tabs.filter(RuntimeCore.isRestrictionSsoTab);
  const requestedPreserveIds = Array.isArray(options.preserveSsoTabIds)
    ? options.preserveSsoTabIds
    : [];
  const foregroundSsoTab = ssoTabs.find((tab) => tab.id === options.foregroundTabId) || null;
  const explicitSsoTabIds = [...new Set([
    foregroundSsoTab?.id,
    ...requestedPreserveIds.filter((tabId) => (
      Number.isInteger(tabId) && ssoTabs.some((tab) => tab.id === tabId)
    )),
  ].filter(Number.isInteger))];
  // Chrome marks one tab active in every window. Preserve only a fresh
  // last-focused/onCreated SSO flow, plus a bounded exception for one sole SSO
  // tab. Multiple dormant background SSO tabs must become removable so the
  // configured numeric limit recovers after focus returns to the destination.
  const preservedSsoTabIds = explicitSsoTabIds.length > 0
    ? explicitSsoTabIds
    : ssoTabs.length === 1
      ? [ssoTabs[0].id]
      : [];
  return [...new Set([
    destination?.id,
    ...preservedSsoTabIds,
  ].filter(Number.isInteger))];
}

function activeCreatedRestrictionSsoTabId(tab) {
  return restrictionSsoPassThroughActive
    && tab?.active === true
    && RuntimeCore.isRestrictionSsoTab(tab)
    && Number.isInteger(tab.id)
    ? tab.id
    : null;
}

async function createdTabPolicyDecision(policyTab, queryTabs, options = {}) {
  const policy = {
    attentionModeActive,
    screenLocked,
    lockedDomain,
    allowedDomains: [...allowedDomains],
    currentMaxTabs,
    restrictionSsoPassThroughActive,
  };
  let policySource = null;
  let notification = null;
  let reconcileExcessTabs = false;
  let removalTarget = null;
  let evaluatedMaxTabs = null;
  if (policy.attentionModeActive) {
    policySource = 'attention_mode';
  } else if (policy.screenLocked && policy.lockedDomain) {
    // Lenient on-domain lock: a new tab already destined for the locked
    // domain (e.g. a middle-clicked link) is allowed; DNR and the
    // navigation listener keep it fenced afterward. Anything else —
    // chrome://newtab, about:blank, off-domain — is removed.
    const createdUrl = policyTab.pendingUrl || policyTab.url || '';
    const onLockedDomain = /^https?:\/\//i.test(createdUrl)
      && isOnSameDomain(createdUrl, policy.lockedDomain);
    const onRestrictionSso = policy.restrictionSsoPassThroughActive
      && Boolean(normalizedRestrictionSsoHost(createdUrl));
    if (!onLockedDomain && !onRestrictionSso) {
      policySource = 'screen_lock';
      notification = {
        title: 'Waypoint Set',
        message: `A waypoint is active at ${policy.lockedDomain}. You can only open new tabs on ${policy.lockedDomain}.`,
        priority: 2,
      };
    }
  }
  if (!policySource && policy.currentMaxTabs) {
    const tabs = await queryTabs({});
    // School settings can arrive independently of browser tab enumeration.
    // Use the effective limit at the completed inventory boundary, not the
    // value captured before the asynchronous query.
    const inventoryMaxTabs = currentMaxTabs;
    evaluatedMaxTabs = inventoryMaxTabs;
    if (inventoryMaxTabs && tabs.length > inventoryMaxTabs) {
      const otherTabs = tabs.filter((candidate) => candidate.id !== policyTab.id);
      const existingCompliant = policy.screenLocked && policy.lockedDomain
        ? otherTabs.find((candidate) => /^https?:\/\//i.test(candidate.pendingUrl || candidate.url || '')
          && isOnSameDomain(candidate.pendingUrl || candidate.url || '', policy.lockedDomain))
        : policy.allowedDomains.length > 0
          ? otherTabs.find((candidate) => /^https?:\/\//i.test(candidate.pendingUrl || candidate.url || '')
            && policy.allowedDomains.some((domain) => (
              isOnSameDomain(candidate.pendingUrl || candidate.url || '', domain)
            )))
          : otherTabs.find((candidate) => !/^(chrome|chrome-extension|devtools):\/\//i.test(
            candidate.pendingUrl || candidate.url || ''
          ));
      // `active` is window-local. With multiple windows, selecting the first
      // active inventory entry can misidentify a background window and allow
      // tab-limit planning to remove the foreground authentication popup.
      // Query Chrome's last-focused window whenever SSO pass-through is live;
      // keep the historical single-query path for ordinary restrictions.
      const foregroundTabs = policy.restrictionSsoPassThroughActive
        ? await queryTabs({ active: true, lastFocusedWindow: true })
        : [];
      const foregroundTab = policy.restrictionSsoPassThroughActive
        ? foregroundTabs.find((candidate) => candidate.active === true)
          || foregroundTabs.find((candidate) => Number.isInteger(candidate?.id))
          || null
        : otherTabs.find((candidate) => candidate.active === true) || null;
      const eventRestrictionSsoTabId = Number.isInteger(options.createdRestrictionSsoTabId)
        && options.createdRestrictionSsoTabId === policyTab.id
        && RuntimeCore.isRestrictionSsoTab(policyTab)
        ? options.createdRestrictionSsoTabId
        : null;
      const createdRestrictionSsoTabId = eventRestrictionSsoTabId
        ?? activeCreatedRestrictionSsoTabId(policyTab);
      // onCreated carries a stronger observation for the tab being evaluated
      // than a separately scheduled last-focused-window query. Chrome can
      // briefly return the previously focused window while an OAuth popup is
      // becoming active; never sacrifice that exact new SSO tab to the limit.
      const foregroundTabId = createdRestrictionSsoTabId !== null
        ? createdRestrictionSsoTabId
        : foregroundTab?.id ?? (policyTab.active ? policyTab.id : null);
      const preserveTabIds = restrictionSsoTabLimitPreserveIds(
        tabs,
        {
          foregroundTabId: foregroundTab?.id,
          preserveSsoTabIds: createdRestrictionSsoTabId !== null
            ? [createdRestrictionSsoTabId]
            : [],
        },
      );
      const removalIds = RuntimeCore.planTabLimitRemovals({
        restrictions: classroomRestrictionsFromRuntime(),
      }, tabs, {
        maxTabs: inventoryMaxTabs,
        foregroundTabId,
        preserveTabId: existingCompliant?.id ?? policyTab.id,
        preserveTabIds,
        preferRemoveTabId: policyTab.id,
      });
      if (removalIds.includes(policyTab.id)) {
        policySource = 'tab_limit';
        const selectedTarget = tabs.find((candidate) => candidate.id === policyTab.id) || policyTab;
        removalTarget = Object.freeze({
          id: selectedTarget.id,
          windowId: selectedTarget.windowId,
          url: String(selectedTarget.url || ''),
          pendingUrl: String(selectedTarget.pendingUrl || ''),
        });
        notification = {
          title: 'Tab Limit Reached',
          message: `You can only have ${inventoryMaxTabs} tabs open at a time.`,
          priority: 1,
        };
      } else if (removalIds.length > 0) {
        // The new tab can be the sole compliant Waypoint target while an
        // older disallowed tab is the removable excess. Run the unified
        // authenticated reconciliation instead of leaving that excess
        // tab alive or sacrificing the compliant target.
        reconcileExcessTabs = true;
      }
    }
  }
  return {
    policySource,
    notification,
    reconcileExcessTabs,
    removalTarget,
    evaluatedMaxTabs,
  };
}

function createdTabRemovalDecisionStillApplies(decision, currentTab) {
  if (!decision?.policySource || !Number.isInteger(currentTab?.id)) return false;
  if (decision.policySource === 'attention_mode') return attentionModeActive;
  if (decision.policySource === 'screen_lock') {
    if (!screenLocked || !lockedDomain) return false;
    const currentUrl = currentTab.pendingUrl || currentTab.url || '';
    if (restrictionSsoPassThroughActive && normalizedRestrictionSsoHost(currentUrl)) return false;
    return !/^https?:\/\//i.test(currentUrl) || !isOnSameDomain(currentUrl, lockedDomain);
  }
  if (decision.policySource === 'tab_limit') {
    return Number.isSafeInteger(currentMaxTabs)
      && currentMaxTabs > 0
      && currentMaxTabs === decision.evaluatedMaxTabs
      && tabLimitTargetMatches(decision.removalTarget, currentTab);
  }
  return false;
}

// Enforce tab limit and screen lock
async function handleCreatedTabForPolicy(tab, options = {}) {
  const getTab = options.getTab || ((tabId) => chrome.tabs.get(tabId));
  const queryTabs = options.queryTabs || ((query) => chrome.tabs.query(query));
  const reconcileTabs = options.reconcileTabs || reconcileClassroomStateTabsBestEffort;
  let eventAuthContext;
  try {
    eventAuthContext = captureAuthenticatedContext('tab created policy event');
  } catch {
    enforceAuthGateForTab(tab).catch(() => {});
    return;
  }
  try {
    await classroomStateRestorePromise;
    // onCreated can initially expose an empty/about:blank URL for an active
    // OAuth popup. Retain the event-time active id as a candidate; every use
    // below revalidates the fresh tab id and exact SSO URL before preserving it.
    const eventRestrictionSsoTabId = restrictionSsoPassThroughActive
      && tab?.active === true
      && Number.isInteger(tab.id)
      ? tab.id
      : null;
    await enqueueStudentAuthMutation(async () => {
      assertAuthenticatedContextCurrent(eventAuthContext, 'tab created policy event');
      enforceAuthGateForTab(tab).catch(() => {});
      if (!Number.isInteger(tab?.id)) return;
      const policyAction = await enqueueClassroomStateOperation(async () => {
        assertAuthenticatedContextCurrent(eventAuthContext, 'tab created classroom policy event');
        // onCreated delivery can trail a classroom-state reconciliation that
        // already navigated this tab. Re-read it only after earlier classroom
        // operations finish so a stale event URL cannot remove the newly
        // compliant Waypoint target.
        const policyTab = await getTab(tab.id).catch(() => null);
        if (!policyTab) return null;
        let decision = await createdTabPolicyDecision(policyTab, queryTabs, {
          createdRestrictionSsoTabId: eventRestrictionSsoTabId,
        });
        assertAuthenticatedContextCurrent(eventAuthContext, 'tab created policy decision');

        if (decision.reconcileExcessTabs) {
          const assertCurrent = (reason = 'tab created limit reconciliation') => {
            assertAuthenticatedContextCurrent(eventAuthContext, reason);
          };
          await reconcileTabs(classroomStateFromRuntimeForReconciliation(), {
            authContext: eventAuthContext,
            assertCurrent,
            foregroundRestrictionSsoTabId: eventRestrictionSsoTabId,
          });
          assertCurrent('tab created limit reconciliation');
          return null;
        }

        if (!decision.policySource) return { refreshTabs: true };

        // Browser navigation is independent of both mutation queues. Re-read
        // and recompute immediately before the destructive point so a tab the
        // browser repurposed after onCreated is never removed from a stale
        // policy snapshot.
        const currentTab = await getTab(policyTab.id).catch(() => null);
        if (!currentTab) return;
        const currentDecision = await createdTabPolicyDecision(currentTab, queryTabs, {
          createdRestrictionSsoTabId: eventRestrictionSsoTabId,
        });
        assertAuthenticatedContextCurrent(eventAuthContext, 'tab created policy revalidation');
        if (currentDecision.reconcileExcessTabs) {
          const assertCurrent = (reason = 'tab created revalidated reconciliation') => {
            assertAuthenticatedContextCurrent(eventAuthContext, reason);
          };
          await reconcileTabs(classroomStateFromRuntimeForReconciliation(), {
            authContext: eventAuthContext,
            assertCurrent,
            foregroundRestrictionSsoTabId: eventRestrictionSsoTabId,
          });
          assertCurrent('tab created revalidated reconciliation');
          return null;
        }
        if (!currentDecision.policySource) {
          return { refreshTabs: true };
        }
        const removalTab = await getTab(policyTab.id).catch(() => null);
        if (!removalTab) return null;
        // A preserved compliant tab may close, the browser may repurpose the
        // target, or the effective limit may change after the prior decision.
        // Re-plan every source from the third live tab read and final inventory;
        // remove only if the latest policy still selects this exact target.
        const finalDecision = await createdTabPolicyDecision(removalTab, queryTabs, {
          createdRestrictionSsoTabId: eventRestrictionSsoTabId,
        });
        assertAuthenticatedContextCurrent(eventAuthContext, 'tab created final policy revalidation');
        if (finalDecision.reconcileExcessTabs) {
          const assertCurrent = (reason = 'tab created final policy reconciliation') => {
            assertAuthenticatedContextCurrent(eventAuthContext, reason);
          };
          await reconcileTabs(classroomStateFromRuntimeForReconciliation(), {
            authContext: eventAuthContext,
            assertCurrent,
            foregroundRestrictionSsoTabId: eventRestrictionSsoTabId,
          });
          assertCurrent('tab created final policy reconciliation');
          return null;
        }
        if (!finalDecision.policySource
          || !createdTabRemovalDecisionStillApplies(finalDecision, removalTab)) {
          return { refreshTabs: true };
        }
        decision = finalDecision;
        await removeTabForAuth(removalTab.id, eventAuthContext, 'tab created policy removal');
        return {
          blockedUrl: removalTab.pendingUrl || removalTab.url || '',
          notification: decision.notification,
          policySource: decision.policySource,
        };
      });

      if (policyAction?.refreshTabs) {
        await refreshTabCache(eventAuthContext);
        assertAuthenticatedContextCurrent(eventAuthContext, 'tab created cache refresh');
        return;
      }
      if (!policyAction?.policySource) return;
      await recordNavigationBlockedForAuth(
        eventAuthContext,
        policyAction.blockedUrl,
        policyAction.policySource,
      );
      if (policyAction.notification) {
        await notifyNavigationBlockedForAuth(
          eventAuthContext,
          policyAction.notification,
          policyAction.policySource,
        );
      }
    });
  } catch (error) {
    if (isAuthContextCancellation(error)) return;
    console.warn('[Service Worker] Tab created handler error:', safeDiagnosticError(error));
  }
}
chrome.tabs.onCreated.addListener(handleCreatedTabForPolicy);

// Refresh tab cache when tabs are removed
chrome.tabs.onRemoved.addListener((tabId) => {
  cameraActiveTabs.delete(tabId);
  cameraActive = cameraActiveTabs.size > 0;
  let authContext;
  try {
    authContext = captureAuthenticatedContext('tab removed cache refresh');
  } catch {
    return;
  }
  refreshTabCache(authContext).catch(() => false);
});

// ============================================================================
// OFFSCREEN DOCUMENT MANAGEMENT (MV3 WebRTC)
// ============================================================================
// In MV3, service workers don't have access to WebRTC/Media APIs
// All WebRTC logic moved to offscreen.js which runs in a page context

async function ensureOffscreenDocument() {
  if (offscreenCloseInFlight) await offscreenCloseInFlight;
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
        console.warn('[Service Worker] Offscreen document creation failed:', safeDiagnosticError(error));
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
  return closeOffscreenDocumentFailPrivate();
}

function closeOffscreenDocumentFailPrivate() {
  if (offscreenCloseInFlight) return offscreenCloseInFlight;
  creatingOffscreen = null;
  offscreenReady = false;
  let closeRequest;
  try {
    // Invoke synchronously after the caller's exact-owner check. A replacement
    // ensureOffscreenDocument observes offscreenCloseInFlight and waits before
    // creating/authenticating its own proxy.
    closeRequest = chrome.offscreen?.closeDocument?.();
  } catch {
    closeRequest = undefined;
  }
  let tracked;
  tracked = Promise.resolve(closeRequest).catch(() => undefined).finally(() => {
    if (offscreenCloseInFlight === tracked) offscreenCloseInFlight = null;
  });
  offscreenCloseInFlight = tracked;
  return tracked;
}

// Send message to offscreen with retry if not ready
async function sendToOffscreen(message, options = {}) {
  await ensureOffscreenDocument();
  options.assertCurrent?.('offscreen document');
  
  // Wait for offscreen to be ready if not yet
  if (!offscreenReady) {
    await new Promise(resolve => setTimeout(resolve, 100));
    options.assertCurrent?.('offscreen readiness');
  }
  
  let response;
  try {
    options.assertCurrent?.('offscreen transmission');
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

function normalizedIceServers(rawServers) {
  if (!Array.isArray(rawServers) || rawServers.length === 0 || rawServers.length > 8) return null;
  const allowedScheme = /^(?:stun|stuns|turn|turns):/i;
  const normalized = [];
  for (const raw of rawServers) {
    const rawUrls = Array.isArray(raw?.urls) ? raw.urls : [raw?.urls];
    const urls = rawUrls
      .map((value) => String(value || '').trim())
      .filter((value) => value && value.length <= 1024 && allowedScheme.test(value));
    if (urls.length === 0 || urls.length !== rawUrls.length || urls.length > 8) return null;
    const entry = { urls: Array.isArray(raw?.urls) ? urls : urls[0] };
    if (raw?.username !== undefined) entry.username = String(raw.username).slice(0, 512);
    if (raw?.credential !== undefined) entry.credential = String(raw.credential).slice(0, 1024);
    normalized.push(entry);
  }
  return normalized;
}

async function fetchLiveViewIceConfiguration(negotiationId, authContext) {
  if (!hasNegotiatedCapability('liveViewIceServersV1', authContext)) {
    return { iceServers: null, expiresAt: null, legacy: true };
  }
  assertAuthenticatedContextCurrent(authContext, 'Live View ICE authorization');
  const response = await fetchWithBackoff(
    `${authContext.serverOrigin}/api/classpilot/device/live-view/ice-servers`,
    {
      method: 'POST',
      headers: buildDeviceAuthHeaders(authContext),
      body: JSON.stringify({ negotiationId }),
      signal: authContext.signal,
    },
    {
      context: 'Live View ICE configuration',
      maxAttempts: 1,
      respectGlobalBackoff: false,
    },
  );
  assertAuthenticatedContextCurrent(authContext, 'Live View ICE authorization');
  if (!response.ok) throw new Error('Live View relay configuration is unavailable');
  const data = await response.json().catch(() => ({}));
  assertAuthenticatedContextCurrent(authContext, 'Live View ICE authorization');
  const expiresAt = parseBoundedExpiry(data.expiresAt);
  const iceServers = normalizedIceServers(data.iceServers);
  if (String(data.negotiationId || '') !== negotiationId
    || !iceServers
    || expiresAt <= Date.now()
    || expiresAt > Date.now() + 11 * 60 * 1000) {
    throw new Error('Live View relay configuration is invalid or stale');
  }
  return { iceServers, expiresAt, legacy: false };
}

function liveViewContextFor(authContext, negotiationId, teachingSessionId) {
  liveViewStartGeneration = Math.max(liveViewStartGeneration + 1, Date.now());
  return Object.freeze({
    negotiationId,
    teachingSessionId,
    startGeneration: liveViewStartGeneration,
    authContextId: authContext.authContextId,
    authGeneration: authContext.mutationGeneration,
    connectionGeneration: wsConnectionGeneration,
    serverOrigin: authContext.serverOrigin,
    studentSessionId: authContext.studentSessionId,
  });
}

function reserveLiveViewNegotiation(negotiationId, authContext) {
  assertAuthenticatedContextCurrent(authContext, 'Live View negotiation reservation');
  const normalizedId = String(negotiationId || '').trim();
  if (!normalizedId) return false;
  const scope = authContextProtocolScope(authContext);
  if (liveViewSeenNegotiationScope !== scope) {
    liveViewSeenNegotiationScope = scope;
    liveViewSeenNegotiationIds = new Set();
  }
  if (liveViewSeenNegotiationIds.has(normalizedId)) return false;
  liveViewSeenNegotiationIds.add(normalizedId);
  if (liveViewSeenNegotiationIds.size > 64) {
    liveViewSeenNegotiationIds = new Set([...liveViewSeenNegotiationIds].slice(-32));
  }
  return true;
}

function liveViewContextMatches(value, authContext = null) {
  if (!activeLiveViewContext || !value) return false;
  let currentContext = authContext;
  try {
    currentContext = currentContext || captureAuthenticatedContext('Live View context');
    assertAuthenticatedContextCurrent(currentContext, 'Live View context');
  } catch {
    return false;
  }
  return String(value.negotiationId || '') === activeLiveViewContext.negotiationId
    && Number(value.startGeneration) === activeLiveViewContext.startGeneration
    && String(value.authContextId || '') === activeLiveViewContext.authContextId
    && Number(value.authGeneration) === activeLiveViewContext.authGeneration
    && Number(value.connectionGeneration) === activeLiveViewContext.connectionGeneration
    && normalizedServerOrigin(value.serverOrigin) === activeLiveViewContext.serverOrigin
    && currentContext.authContextId === activeLiveViewContext.authContextId
    && currentContext.studentSessionId === activeLiveViewContext.studentSessionId;
}

function assertLiveViewRequestCurrent(requestContext, authContext, reason = 'Live View request') {
  assertAuthenticatedContextCurrent(authContext, reason);
  if (activeLiveViewContext !== requestContext
    || !liveViewContextMatches(requestContext, authContext)) {
    const error = new Error('Live View request was replaced by a newer negotiation');
    error.code = 'LIVE_VIEW_CONTEXT_SUPERSEDED';
    throw error;
  }
  return requestContext;
}

async function notifyLiveViewErrorForAuth(authContext, requestContext, reason = 'capture') {
  assertLiveViewRequestCurrent(requestContext, authContext, 'Live View error notification');
  await notifyTeacherMessageForAuth({
    title: 'Screen Sharing Error',
    // Never surface the offscreen/browser error body. It can contain page,
    // device, or media details and is not part of the user-facing allowlist.
    message: 'Unable to start the requested screen share.',
    priority: 1,
  }, authContext, browserPolicyEnvelopeForAuth(authContext), (
    `live-view-${requestContext.negotiationId}-${requestContext.startGeneration}-${reason}`
  ));
  assertLiveViewRequestCurrent(requestContext, authContext, 'Live View error notification');
}

function liveViewOffscreenIdentity(context = activeLiveViewContext) {
  return context ? {
    negotiationId: context.negotiationId,
    startGeneration: context.startGeneration,
    authContextId: context.authContextId,
    authGeneration: context.authGeneration,
    connectionGeneration: context.connectionGeneration,
    serverOrigin: context.serverOrigin,
    studentSessionId: context.studentSessionId,
  } : {};
}

async function sendLiveViewAttemptTelemetry(message) {
  let authContext;
  try {
    authContext = captureAuthenticatedContext('Live View telemetry');
    if (!hasNegotiatedCapability('liveViewIceServersV1', authContext)) return false;
    if (!liveViewContextMatches(message, authContext)) return false;
    const negotiationId = String(message.negotiationId || '').trim();
    const attempt = Number(message.attempt);
    const outcome = String(message.outcome || '');
    const connectionTimeMs = Number(message.connectionTimeMs);
    const selectedCandidateType = String(message.selectedCandidateType || 'unknown');
    const relayTransport = String(message.relayTransport || 'unknown');
    if (
      negotiationId !== activeLiveViewContext?.negotiationId
      || !Number.isSafeInteger(attempt)
      || attempt < 0
      || attempt > 2
      || !['connected', 'failed'].includes(outcome)
      || !Number.isSafeInteger(connectionTimeMs)
      || connectionTimeMs < 0
      || connectionTimeMs > 90000
      || !['host', 'server_reflexive', 'relay', 'unknown'].includes(selectedCandidateType)
      || (selectedCandidateType === 'relay'
        && !['udp', 'tcp', 'tls', 'unknown'].includes(relayTransport))
      || (selectedCandidateType !== 'relay' && message.relayTransport !== undefined)
    ) return false;
    const attemptKey = `${negotiationId}:${attempt}`;
    if (liveViewTelemetryAttempts.has(attemptKey)) return false;
    liveViewTelemetryAttempts.add(attemptKey);
    if (liveViewTelemetryAttempts.size > 8) {
      liveViewTelemetryAttempts = new Set([...liveViewTelemetryAttempts].slice(-4));
    }
    const payload = {
      negotiationId,
      attempt,
      outcome,
      connectionTimeMs,
      selectedCandidateType,
      ...(selectedCandidateType === 'relay' ? { relayTransport } : {}),
    };
    assertAuthenticatedContextCurrent(authContext, 'Live View telemetry');
    const response = await fetchWithBackoff(
      `${authContext.serverOrigin}/api/classpilot/device/live-view/telemetry`,
      {
        method: 'POST',
        headers: buildDeviceAuthHeaders(authContext),
        body: JSON.stringify(payload),
        signal: authContext.signal,
      },
      {
        context: 'Live View telemetry',
        maxAttempts: 1,
        respectGlobalBackoff: false,
      },
    );
    assertAuthenticatedContextCurrent(authContext, 'Live View telemetry');
    return response.ok;
  } catch {
    // Diagnostics are deliberately best effort. Signaling and cleanup never
    // depend on telemetry delivery, and no payload/error details are logged.
    return false;
  }
}

// WebRTC: Handle screen share request from teacher (orchestrate via offscreen)
async function handleScreenShareRequest(
  mode = 'auto',
  negotiationId = null,
  teachingSessionId = null,
  setupExpiresAt = null,
  expiresAt = null,
) {
  let authContext;
  let requestContext = null;
  let startTransmissionAttempted = false;
  try {
    authContext = captureAuthenticatedContext('Live View start');
    requestContext = activeLiveViewContext;
    if (!negotiationId
      || negotiationId !== activeLiveViewNegotiationId
      || teachingSessionId !== activeLiveViewTeachingSessionId
      || !liveViewContextMatches(requestContext, authContext)) return;
    console.log('[WebRTC] Teacher requested screen share, mode:', safeDiagnosticLabel(mode));

    const iceConfiguration = await fetchLiveViewIceConfiguration(negotiationId, authContext);
    assertLiveViewRequestCurrent(requestContext, authContext, 'Live View ICE configuration');

    // Ensure offscreen document exists
    await ensureOffscreenDocument();
    assertLiveViewRequestCurrent(requestContext, authContext, 'Live View offscreen setup');

    // MV3: Get a stream ID from the service worker via tabCapture.getMediaStreamId
    // This is the correct MV3 approach - tabCapture.capture() doesn't work in offscreen docs
    // On managed browsers with TabCaptureAllowedByOrigins policy, this enables silent capture
    let streamId = null;
    if (mode === 'auto' || mode === 'tab') {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        assertLiveViewRequestCurrent(requestContext, authContext, 'Live View active tab');
        if (activeTab?.id) {
          // Try without consumerTabId first (for offscreen document consumption)
          try {
            streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
            assertLiveViewRequestCurrent(requestContext, authContext, 'Live View stream id');
            console.log('[WebRTC] Got tab capture stream ID (method 1)');
          } catch (e1) {
            if (e1?.code === 'LIVE_VIEW_CONTEXT_SUPERSEDED'
              || isAuthContextCancellation(e1)) throw e1;
            console.info('[WebRTC] Method 1 failed; trying without targetTabId');
            // Some Chrome versions need no targetTabId for offscreen docs
            try {
              streamId = await chrome.tabCapture.getMediaStreamId({});
              assertLiveViewRequestCurrent(requestContext, authContext, 'Live View stream id');
              console.log('[WebRTC] Got tab capture stream ID (method 2, no target)');
            } catch (e2) {
              if (e2?.code === 'LIVE_VIEW_CONTEXT_SUPERSEDED'
                || isAuthContextCancellation(e2)) throw e2;
              console.info('[WebRTC] Method 2 also failed:', safeDiagnosticError(e2));
            }
          }
        } else {
          console.info('[WebRTC] No active tab found for tab capture');
        }
      } catch (tabErr) {
        if (tabErr?.code === 'LIVE_VIEW_CONTEXT_SUPERSEDED'
          || isAuthContextCancellation(tabErr)) throw tabErr;
        console.info('[WebRTC] tabCapture.getMediaStreamId failed:', safeDiagnosticError(tabErr));
      }
    }

    // Tell offscreen to start capture with the streamId (if available)
    assertLiveViewRequestCurrent(requestContext, authContext, 'Live View start transmission');
    startTransmissionAttempted = true;
    const result = await sendToOffscreen({
      type: 'START_SHARE',
      mode: mode,
      streamId: streamId,
      negotiationId,
      teachingSessionId,
      setupExpiresAt,
      expiresAt,
      iceServers: iceConfiguration.iceServers,
      iceConfigurationExpiresAt: iceConfiguration.expiresAt,
      ...liveViewOffscreenIdentity(requestContext),
    }, {
      assertCurrent: (phase) => assertLiveViewRequestCurrent(
        requestContext,
        authContext,
        `Live View ${phase}`,
      ),
    });
    assertLiveViewRequestCurrent(requestContext, authContext, 'Live View start response');

    if (!result?.success) {
      // Check if this is an expected failure (user denied, etc.)
      if (result?.status === 'user-denied') {
        await stopScreenShare({
          reason: result.status,
          expectedContext: requestContext,
        });
        console.info('[WebRTC] User denied screen share (expected behavior)');
        return;
      } else if (result?.status === 'tab-capture-unavailable') {
        await stopScreenShare({
          reason: result.status,
          expectedContext: requestContext,
        });
        console.info('[WebRTC] Silent tab capture not available (expected on unmanaged devices)');
        return;
      } else {
        console.warn('[WebRTC] Unexpected screen share error');
        let notificationError = null;
        try {
          await notifyLiveViewErrorForAuth(authContext, requestContext, 'start-result');
        } catch (error) {
          notificationError = error;
        }
        await stopScreenShare({
          reason: result?.status || 'capture-start-failed',
          expectedContext: requestContext,
        });
        if (notificationError && !isAuthContextCancellation(notificationError)) {
          console.warn('[WebRTC] Screen share error notification unavailable:', safeDiagnosticError(notificationError));
        }
        return;
      }
    }

    if (!liveViewContextMatches(requestContext, authContext)) {
      await sendToOffscreen({
        type: 'STOP_SHARE',
        ...liveViewOffscreenIdentity(requestContext),
      }).catch(() => {});
      return;
    }
    setObservedState(true, 'teacher-request');
    console.log('[WebRTC] Screen capture initiated in offscreen document');

  } catch (error) {
    if (error?.code === 'LIVE_VIEW_CONTEXT_SUPERSEDED'
      || isAuthContextCancellation(error)) {
      if (startTransmissionAttempted && requestContext) {
        // START_SHARE may have reached offscreen before the post-response
        // authority fence observed retirement. Retire only that exact start;
        // an offscreen replacement rejects the stale tuple and remains intact.
        await sendToOffscreen({
          type: 'STOP_SHARE',
          ...liveViewOffscreenIdentity(requestContext),
        }).catch(() => {});
      }
      return;
    }
    // Bind the user-visible error to the exact negotiation before cleanup
    // clears activeLiveViewContext. If authority changes during notification
    // creation, the auth-bound notification helper removes the stale item.
    let notificationError = null;
    if (authContext && requestContext && liveViewContextMatches(requestContext, authContext)) {
      try {
        await notifyLiveViewErrorForAuth(authContext, requestContext, 'start-exception');
      } catch (notifyError) {
        notificationError = notifyError;
      }
    }
    await stopScreenShare({
      reason: 'capture-start-error',
      notifyServer: !isAuthContextCancellation(error),
      expectedContext: requestContext,
    });
    // Only unexpected errors reach here
    console.warn('[WebRTC] Unexpected screen share request error:', safeDiagnosticError(error));
    if (notificationError && !isAuthContextCancellation(notificationError)) {
      console.warn('[WebRTC] Screen share error notification unavailable:', safeDiagnosticError(notificationError));
    }
  }
}

// WebRTC: Handle stop screen share request from teacher
async function handleStopScreenShare(negotiationId = null) {
  const expectedContext = activeLiveViewContext;
  const expectedTransportIdentity = wsTransportIdentity;
  let stopFailed = false;
  try {
    const authContext = captureAuthenticatedContext('Live View stop');
    if (!negotiationId
      || negotiationId !== activeLiveViewNegotiationId
      || !liveViewContextMatches(expectedContext, authContext)) return;
    console.log('[WebRTC] Teacher requested to stop screen share');
    setObservedState(false, 'teacher-stop');
    
    // Tell offscreen to stop sharing and clean up
    const result = await sendToOffscreen({
      type: 'STOP_SHARE',
      ...liveViewOffscreenIdentity(expectedContext),
    });
    if (activeLiveViewContext !== expectedContext
      || !liveViewContextMatches(expectedContext, authContext)) return;

    if (result?.success) {
      console.log('[WebRTC] Screen share stopped successfully');
    } else {
      console.info('[WebRTC] Stop share completed');
    }
    if (activeLiveViewContext === expectedContext) {
      activeLiveViewNegotiationId = null;
      activeLiveViewTeachingSessionId = null;
      activeLiveViewContext = null;
    }
    
  } catch (error) {
    stopFailed = true;
    console.warn('[WebRTC] Error stopping screen share:', safeDiagnosticError(error));
  } finally {
    if (activeLiveViewContext === expectedContext) {
      if (
        stopFailed
        && expectedContext
        && wsTransportIdentity === expectedTransportIdentity
      ) {
        // A rejected STOP is not proof that offscreen released its MediaStream.
        // Close the captured owner's document fail-private; replacement setup
        // observes the close flight and cannot be killed by this cleanup.
        await closeOffscreenDocumentFailPrivate();
      }
      if (activeLiveViewContext === expectedContext) {
        activeLiveViewNegotiationId = null;
        activeLiveViewTeachingSessionId = null;
        activeLiveViewContext = null;
      }
    }
  }
}

// WebRTC: Handle offer from teacher (forward to offscreen)
async function handleOffer(sdp, from, negotiationId, restartGeneration = 0) {
  const expectedContext = activeLiveViewContext;
  try {
    const authContext = captureAuthenticatedContext('Live View offer');
    if (!negotiationId
      || negotiationId !== activeLiveViewNegotiationId
      || !liveViewContextMatches(expectedContext, authContext)) return;
    console.log('[WebRTC] Forwarding offer to offscreen document');
    
    const response = await sendToOffscreen({
      type: 'SIGNAL',
      payload: { type: 'offer', sdp: sdp, from: from, negotiationId, restartGeneration },
      ...liveViewOffscreenIdentity(expectedContext),
    });
    if (activeLiveViewContext !== expectedContext
      || !liveViewContextMatches(expectedContext, authContext)) return;

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
      console.warn('[WebRTC] Unexpected offer handling error');
      return;
    }
    
    console.log('[WebRTC] Offer handled in offscreen document');
  } catch (error) {
    // Only unexpected errors reach here
    console.warn('[WebRTC] Unexpected error handling offer:', safeDiagnosticError(error));
  }
}

// WebRTC: Handle ICE candidate from teacher (forward to offscreen)
async function handleIceCandidate(candidate, negotiationId, restartGeneration = 0) {
  const expectedContext = activeLiveViewContext;
  try {
    const authContext = captureAuthenticatedContext('Live View ICE candidate');
    if (!negotiationId
      || negotiationId !== activeLiveViewNegotiationId
      || !liveViewContextMatches(expectedContext, authContext)) return;
    const response = await sendToOffscreen({
      type: 'SIGNAL',
      payload: { type: 'ice', candidate: candidate, negotiationId, restartGeneration },
      ...liveViewOffscreenIdentity(expectedContext),
    });
    if (activeLiveViewContext !== expectedContext
      || !liveViewContextMatches(expectedContext, authContext)) return;

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
  const expectedContext = options.expectedContext || activeLiveViewContext;
  const expectedTransportIdentity = wsTransportIdentity;
  const negotiationId = expectedContext?.negotiationId || activeLiveViewNegotiationId || null;
  let stopFailed = false;
  if (negotiationId
    && activeLiveViewContext === expectedContext
    && options.notifyServer !== false) {
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
      type: 'STOP_SHARE',
      ...liveViewOffscreenIdentity(expectedContext),
    });
    // The offscreen document also owns the durable student WebSocket. Keep it
    // alive while monitoring is ACTIVE/IDLE; OFF/sign-out performs the close.
    if (
      trackingState === TRACKING_STATES.OFF
      && activeLiveViewContext === expectedContext
      && wsTransportIdentity === expectedTransportIdentity
    ) {
      await closeOffscreenDocument();
    }
  } catch (error) {
    stopFailed = true;
    console.warn('[WebRTC] Error stopping screen share:', safeDiagnosticError(error));
  } finally {
    if (!expectedContext || activeLiveViewContext === expectedContext) {
      if (
        stopFailed
        && expectedContext
        && activeLiveViewContext === expectedContext
        && wsTransportIdentity === expectedTransportIdentity
      ) {
        await closeOffscreenDocumentFailPrivate();
      }
      if (!expectedContext || activeLiveViewContext === expectedContext) {
        activeLiveViewNegotiationId = null;
        activeLiveViewTeachingSessionId = null;
        activeLiveViewContext = null;
      }
    }
  }
}

async function handleOffscreenMessage(message) {
  if (message.type === 'SCREENSHOT_CADENCE_TICK') {
    const cadence = activeScreenshotCadence;
    if (
      !cadence
      || message.cadenceId !== cadence.cadenceId
      || Number(message.generation) !== cadence.generation
    ) return { success: true, ignored: true };
    if (Date.now() >= cadence.expiresAt) {
      expireActiveScreenshotCadence('active-view-expired');
      return { success: true, expired: true };
    }
    let authContext;
    try {
      authContext = captureAuthenticatedContext('active observation screenshot tick');
    } catch {
      return { success: true, ignored: true };
    }
    if (
      cadence.authContextId !== authContext.authContextId
      || cadence.authorityScope !== screenshotPolicyState.authorityScope
      || activeScreenshotCadence !== cadence
      || !activeObservationScreenshotCadenceAllowed(authContext)
    ) return { success: true, ignored: true };
    await captureAndSendScreenshot({ reason: 'active-view-tick' });
    return { success: true };
  }

  if (message.type === 'SCREENSHOT_CADENCE_EXPIRED') {
    const cadence = activeScreenshotCadence;
    if (
      !cadence
      || message.cadenceId !== cadence.cadenceId
      || Number(message.generation) !== cadence.generation
    ) return { success: true, ignored: true };
    expireActiveScreenshotCadence('active-view-expired');
    return { success: true, expired: true };
  }

  if (message.type === 'WS_EVENT') {
    await handleWsEvent(
      message.event,
      message.data,
      message.connectionGeneration,
      message.authContextId,
      message.serverOrigin,
    );
    return { success: true };
  }

  if (message.type === 'ICE_CANDIDATE') {
    if (liveViewContextMatches(message)) {
      await wsSend({
        type: 'ice',
        to: 'teacher',
        negotiationId: message.negotiationId,
        restartGeneration: Number(message.restartGeneration || 0),
        candidate: message.candidate,
      });
    }
    return { success: true };
  }

  if (message.type === 'ANSWER') {
    if (liveViewContextMatches(message)) {
      await wsSend({
        type: 'answer',
        to: 'teacher',
        negotiationId: message.negotiationId,
        restartGeneration: Number(message.restartGeneration || 0),
        sdp: message.sdp,
      });
    }
    return { success: true };
  }

  if (message.type === 'ICE_RESTART_REQUIRED') {
    if (liveViewContextMatches(message)) {
      await wsSend({
        type: 'ice-restart',
        to: 'teacher',
        negotiationId: message.negotiationId,
        restartGeneration: Number(message.restartGeneration || 0),
      });
    }
    return { success: true };
  }

  if (message.type === 'LIVE_VIEW_ATTEMPT_TERMINAL') {
    if (!liveViewContextMatches(message)) return { success: true, ignored: true };
    await sendLiveViewAttemptTelemetry(message);
    return { success: true };
  }

  if (message.type === 'CONNECTION_FAILED') {
    if (!liveViewContextMatches(message)) return { success: true, ignored: true };
    console.log('[WebRTC] Connection failed, cleaning up');
    await stopScreenShare();
    setObservedState(false, 'connection-failed');
    return { success: true };
  }

  if (message.type === 'CAPTURE_ERROR') {
    const requestContext = activeLiveViewContext;
    let authContext;
    try {
      authContext = captureAuthenticatedContext('Live View capture error');
      if (!requestContext || !liveViewContextMatches(message, authContext)) {
        return { success: true, ignored: true };
      }
      setObservedState(false, 'capture-error');
      let notificationError = null;
      try {
        await notifyLiveViewErrorForAuth(authContext, requestContext, 'capture-error');
      } catch (error) {
        notificationError = error;
      }
      await stopScreenShare({
        reason: 'capture-error',
        expectedContext: requestContext,
      });
      if (notificationError && !isAuthContextCancellation(notificationError)) {
        console.warn('[WebRTC] Capture error notification unavailable:', safeDiagnosticError(notificationError));
      }
      return { success: true, ignored: Boolean(notificationError && isAuthContextCancellation(notificationError)) };
    } catch (error) {
      if (isAuthContextCancellation(error) || error?.code === 'LIVE_VIEW_CONTEXT_SUPERSEDED') {
        return { success: true, ignored: true };
      }
      throw error;
    }
  }

  if (message.type === 'LIVE_VIEW_EXPIRED') {
    const negotiationId = String(message.negotiationId || '').trim();
    if (!liveViewContextMatches(message)) return { success: true, ignored: true };
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
      activeLiveViewContext = null;
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

  console.log('[Service Worker] Message from offscreen:', safeDiagnosticLabel(message.type));

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

function wsIdentityMatchesContext(value, authContext) {
  return Boolean(
    value
    && Number(value.connectionGeneration) === Number(wsConnectionGeneration)
    && String(value.authContextId || '') === authContext.authContextId
    && normalizedServerOrigin(value.serverOrigin) === authContext.serverOrigin
  );
}

async function closeReportedOffscreenWebSocket(status) {
  if (!status) return;
  await sendToOffscreen({
    type: 'WS_CLOSE',
    connectionGeneration: status.connectionGeneration,
    authContextId: status.authContextId || undefined,
    serverOrigin: status.serverOrigin || undefined,
  }).catch(() => {});
}

async function recoverOffscreenWebSocketStatus(authContext) {
  assertAuthenticatedContextCurrent(authContext, 'WebSocket recovery');
  const status = await queryOffscreenWebSocketStatus();
  assertAuthenticatedContextCurrent(authContext, 'WebSocket recovery');
  if (!status) return false;
  const generation = Number(status.connectionGeneration || 0);
  const identityMatches = String(status.authContextId || '') === authContext.authContextId
    && normalizedServerOrigin(status.serverOrigin) === authContext.serverOrigin;
  if (!Number.isSafeInteger(generation) || generation < 1 || !identityMatches) {
    if (Number.isSafeInteger(generation)) {
      wsConnectionGeneration = Math.max(wsConnectionGeneration, generation);
    }
    await closeReportedOffscreenWebSocket(status);
    wsConnected = false;
    wsTransportConnected = false;
    wsAuthenticatedGeneration = 0;
    wsTransportIdentity = null;
    return false;
  }
  if (generation < wsConnectionGeneration) {
    await closeReportedOffscreenWebSocket(status);
    return false;
  }
  if (Number.isSafeInteger(generation) && generation > wsConnectionGeneration) {
    wsConnectionGeneration = generation;
  }
  // An offscreen MediaStream can outlive the MV3 service worker that created
  // it. The restarted worker has no safely reauthorized negotiation state, so
  // fail private and stop the exact surviving capture before adopting the
  // otherwise valid socket.
  if (status.liveViewIdentity) {
    const liveIdentity = status.liveViewIdentity;
    const liveIdentityMatchesSocket = String(liveIdentity.authContextId || '')
        === authContext.authContextId
      && Number(liveIdentity.connectionGeneration) === generation
      && normalizedServerOrigin(liveIdentity.serverOrigin) === authContext.serverOrigin;
    if (!liveIdentityMatchesSocket) {
      await closeReportedOffscreenWebSocket(status);
      return false;
    }
    await sendToOffscreen({
      type: 'STOP_SHARE',
      ...liveIdentity,
    });
    assertAuthenticatedContextCurrent(authContext, 'WebSocket recovery');
    // Establish a fresh proxy generation after stopping an orphaned stream.
    // This is the durable worker-epoch boundary: delayed START_SHARE frames
    // from the retired worker no longer match the authenticated proxy even if
    // its local start counter or system clock was higher.
    await closeReportedOffscreenWebSocket(status);
    assertAuthenticatedContextCurrent(authContext, 'WebSocket recovery');
    wsConnected = false;
    wsTransportConnected = false;
    wsAuthenticatedGeneration = 0;
    wsTransportIdentity = null;
    return false;
  }
  wsTransportIdentity = {
    connectionGeneration: wsConnectionGeneration,
    authContextId: authContext.authContextId,
    serverOrigin: authContext.serverOrigin,
  };
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
  let requestedAuthContext = null;
  try {
    requestedAuthContext = captureAuthenticatedContext('WebSocket connect reservation');
  } catch {
    // connectWebSocketNow retains the established signed-out/off-hours path.
  }
  const requestedIdentity = requestedAuthContext
    ? authContextProtocolScope(requestedAuthContext)
    : 'signed-out';
  if (wsConnectInFlight && wsConnectInFlightIdentity === requestedIdentity) {
    return wsConnectInFlight;
  }
  const pending = connectWebSocketNow(requestedAuthContext);
  wsConnectInFlight = pending;
  wsConnectInFlightIdentity = requestedIdentity;
  try {
    return await pending;
  } finally {
    if (wsConnectInFlight === pending) {
      wsConnectInFlight = null;
      wsConnectInFlightIdentity = null;
    }
  }
}

async function connectWebSocketNow(requestedAuthContext = null) {
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
  let authContext;
  try {
    authContext = requestedAuthContext || captureAuthenticatedContext('WebSocket connect');
    assertAuthenticatedContextCurrent(authContext, 'WebSocket connect');
  } catch (error) {
    if (isAuthContextCancellation(error)) return false;
    throw error;
  }

  // Clear any pending reconnection alarm since we're connecting now
  chrome.alarms.clear('ws-reconnect');

  // Ensure offscreen document exists (it hosts the WebSocket)
  await ensureOffscreenDocument();
  assertAuthenticatedContextCurrent(authContext, 'WebSocket connect');

  if (await recoverOffscreenWebSocketStatus(authContext)) {
    console.log('[WebSocket] Recovered authenticated offscreen transport');
    return true;
  }

  const protocol = authContext.serverOrigin.startsWith('https') ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${new URL(authContext.serverOrigin).host}/ws`;

  // Build auth payload to send immediately on connection
  const authPayload = {
    type: 'auth',
    role: 'student',
    deviceId: authContext.deviceId,
    ...extensionProtocolDescriptor(),
  };
  if (authContext.studentToken) {
    authPayload.studentToken = authContext.studentToken;
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
  const wsProtocolPolicyGeneration = reserveProtocolPolicyRequestGeneration();
  const wsScreenshotPolicyGeneration = reserveScreenshotPolicyRequestGeneration();
  const wsAuthRequestStartedAt = Date.now();
  wsTransportIdentity = {
    connectionGeneration: wsConnectionGeneration,
    authContextId: authContext.authContextId,
    serverOrigin: authContext.serverOrigin,
  };
  wsAuthenticatedResponseGuard = {
    connectionGeneration: wsConnectionGeneration,
    responseGuard: captureAuthenticatedResponseGuard(),
    authContext,
    protocolPolicyGeneration: wsProtocolPolicyGeneration,
    screenshotPolicyGeneration: wsScreenshotPolicyGeneration,
    requestStartedAt: wsAuthRequestStartedAt,
  };
  try {
    assertAuthenticatedContextCurrent(authContext, 'WebSocket connect');
    const response = await sendToOffscreen({
      type: 'WS_CONNECT',
      url: wsUrl,
      authPayload,
      connectionGeneration: wsConnectionGeneration,
      authContextId: authContext.authContextId,
      serverOrigin: authContext.serverOrigin,
    });
    assertAuthenticatedContextCurrent(authContext, 'WebSocket connect');
    if (!wsIdentityMatchesContext(response, authContext)) {
      throw authContextSuperseded('WebSocket connection response');
    }
    console.log('[WebSocket] Connection request sent to offscreen document, generation',
      response.connectionGeneration);
    return true;
  } catch (error) {
    if (isAuthContextCancellation(error)) {
      console.info('[WebSocket] Discarded connection for a retired authentication context');
      return false;
    }
    console.warn('[WebSocket] Failed to send connect request to offscreen:', safeDiagnosticError(error));
    scheduleWsReconnect();
    return false;
  }
}

// Handle WebSocket events relayed from the offscreen document in transport
// order. Offscreen emits frames without awaiting runtime.sendMessage, so an
// explicit per-generation tail is required to keep auth/state/commands causal.
function handleWsEvent(event, data, connectionGeneration, authContextId, serverOrigin) {
  const generation = Number(connectionGeneration || 0);
  let authContext;
  try {
    authContext = captureAuthenticatedContext('WebSocket event');
  } catch {
    return Promise.resolve({ ignored: true });
  }
  if (
    generation !== wsConnectionGeneration
    || String(authContextId || '') !== authContext.authContextId
    || normalizedServerOrigin(serverOrigin) !== authContext.serverOrigin
    || !wsIdentityMatchesContext({ connectionGeneration, authContextId, serverOrigin }, authContext)
  ) {
    console.info('[WebSocket] Ignoring stale transport event for generation', generation);
    return Promise.resolve({ ignored: true });
  }
  if (wsMessageProcessingGeneration !== generation) {
    wsMessageProcessingGeneration = generation;
    wsMessageProcessingTail = Promise.resolve();
  }
  const processing = wsMessageProcessingTail.then(
    () => processWsEvent(event, data, generation, authContext),
    () => processWsEvent(event, data, generation, authContext),
  );
  wsMessageProcessingTail = processing.catch(() => undefined);
  return processing;
}

async function processWsEvent(event, data, generation, authContext) {
  try {
    assertAuthenticatedContextCurrent(authContext, 'WebSocket event');
  } catch {
    return { ignored: true };
  }
  if (generation !== wsConnectionGeneration) return { ignored: true };
  if (event === 'open') {
    console.log('WebSocket transport connected (via offscreen)');
    wsTransportConnected = true;
    wsConnected = false;
  } else if (event === 'error') {
    console.warn('WebSocket connection issue');
    scheduleWsReconnect();
  } else if (event === 'close') {
    const closingTransportIdentity = wsTransportIdentity;
    const closingLiveViewContext = activeLiveViewContext;
    const closingLiveViewNegotiationId = activeLiveViewNegotiationId;
    const closingLiveViewTeachingSessionId = activeLiveViewTeachingSessionId;
    const sourceMessage = browserPolicyEnvelopeForAuth(authContext);
    console.log('WebSocket disconnected');
    wsConnected = false;
    wsTransportConnected = false;
    wsAuthenticatedGeneration = 0;
    if (wsTransportIdentity === closingTransportIdentity) wsTransportIdentity = null;
    setObservedState(false, 'ws-closed');
    await cleanupTeacherBroadcast('ws-closed', {
      notifyTeacher: false,
      authContext,
      sourceMessage,
    });
    assertAuthenticatedContextCurrent(authContext, 'WebSocket close cleanup');
    if (generation !== wsConnectionGeneration) return { ignored: true };
    if (
      closingLiveViewNegotiationId
      && activeLiveViewContext === closingLiveViewContext
      && activeLiveViewNegotiationId === closingLiveViewNegotiationId
      && activeLiveViewTeachingSessionId === closingLiveViewTeachingSessionId
    ) {
      await stopScreenShare({
        notifyServer: false,
        reason: 'student-websocket-closed',
        expectedContext: closingLiveViewContext,
      });
      assertAuthenticatedContextCurrent(authContext, 'WebSocket close screen-share cleanup');
    }
    scheduleWsReconnect();
  } else if (event === 'message') {
    await handleWsMessage(data, generation, authContext);
  }
  return { handled: true };
}

// Process incoming WebSocket message (same logic as before, just extracted)
async function handleWsMessage(
  rawData,
  connectionGeneration = wsConnectionGeneration,
  expectedAuthContext = null,
) {
    if (Number(connectionGeneration) !== wsConnectionGeneration) return;
    try {
      const authContext = expectedAuthContext || captureAuthenticatedContext('WebSocket message');
      assertAuthenticatedContextCurrent(authContext, 'WebSocket message');
      const message = JSON.parse(rawData);
      console.log('[WebSocket] Received frame:', safeDiagnosticLabel(message?.type));

      if (message.type === 'command-ack-receipt') {
        assertAuthenticatedContextCurrent(authContext, 'command acknowledgement receipt');
        const removed = await removeAcceptedCommandAckReceipts([message], authContext);
        assertAuthenticatedContextCurrent(authContext, 'command acknowledgement receipt');
        if (removed !== 1) {
          console.warn('[Command ACK] Ignoring non-positive or non-exact receipt');
        }
        return;
      }

      if (message.type === 'chat-message-ack-receipt') {
        assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement receipt');
        const removed = await removeAcceptedChatAckReceipts([message], authContext);
        assertAuthenticatedContextCurrent(authContext, 'chat acknowledgement receipt');
        if (removed !== 1) {
          console.warn('[Chat ACK] Ignoring non-positive or non-exact receipt');
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
          if (
            wsAuthenticatedResponseGuard?.authContext?.authContextId !== authContext.authContextId
            || wsAuthenticatedResponseGuard?.authContext?.mutationGeneration !== authContext.mutationGeneration
          ) {
            throw authContextSuperseded('WebSocket authentication');
          }
          const authenticatedResponseGuard = wsAuthenticatedResponseGuard?.connectionGeneration === connectionGeneration
            ? wsAuthenticatedResponseGuard
            : null;
          if (!authenticatedResponseGuard) {
            throw authContextSuperseded('WebSocket authentication generation');
          }
          const responseGuard = authenticatedResponseGuard.responseGuard;
          await adoptAuthenticatedStudentBinding(message, 'websocket auth', responseGuard);
          assertAuthenticatedContextCurrent(authContext, 'WebSocket authentication');
          adoptProtocolAndScreenshotPolicy(message, authContext, {
            requestGeneration: authenticatedResponseGuard.protocolPolicyGeneration,
            screenshotRequestGeneration: authenticatedResponseGuard.screenshotPolicyGeneration,
            requestStartedAt: authenticatedResponseGuard.requestStartedAt,
            responseReceivedAt: Date.now(),
            policySource: 'websocket',
          });
        } catch (error) {
          console.warn('[WebSocket] Exact student binding was rejected:', safeDiagnosticError(error));
          wsConnected = false;
          wsAuthenticatedGeneration = 0;
          await disconnectWebSocket({ authContext });
          return;
        }
        wsTransportConnected = true;
        wsConnected = true;
        wsAuthenticatedGeneration = wsConnectionGeneration;
        wsReconnectBackoffMs = 10000;
        chrome.alarms.clear('ws-reconnect');
        await flushCommandAckOutbox().catch(() => {});
        assertAuthenticatedContextCurrent(authContext, 'WebSocket authentication ACK flush');
        await flushChatAckOutbox().catch(() => {});
        assertAuthenticatedContextCurrent(authContext, 'WebSocket authentication chat ACK flush');
        
        // Always update maxTabsPerStudent (including null for unlimited), but
        // serialize destructive enforcement with authentication adoption.
        if (Object.prototype.hasOwnProperty.call(message.settings || {}, 'maxTabsPerStudent')) {
          try {
            await applyWebSocketTabLimitSetting(message, authContext);
          } catch (error) {
            if (isAuthContextCancellation(error)) throw error;
            console.warn('Error enforcing tab limit:', safeDiagnosticError(error));
          }
        }

        // Handle global blocked domains (school-wide blacklist)
        if (message.settings && message.settings.globalBlockedDomains) {
          const receivedGlobalBlockedDomains = message.settings.globalBlockedDomains;
          console.log('[Blacklist] Received updated school policy');

          // Apply blacklist rules and persist to storage
          try {
            await updateGlobalBlacklistRules(receivedGlobalBlockedDomains, {
              authContext,
              sourceMessage: message,
            });
            assertAuthenticatedContextCurrent(authContext, 'WebSocket blacklist persistence');
            console.log('[Blacklist] Persisted to storage');
          } catch (error) {
            if (isAuthContextCancellation(error)) throw error;
            console.warn('[Blacklist] Error applying rules:', safeDiagnosticError(error));
          }
        }

        const authStateEnvelope = Object.prototype.hasOwnProperty.call(message, 'classroomState')
          ? message
          : message.settings && Object.prototype.hasOwnProperty.call(message.settings, 'classroomState')
            // Preserve the authenticated frame's exact binding and negotiated
            // protocol envelope when SchoolPilot nests the snapshot in
            // settings. A marker copied into a state-only object would lose
            // the school/device/session fence and correctly fail closed.
            ? { ...message, classroomState: message.settings.classroomState }
            : null;
        if (authStateEnvelope) {
          await applyClassroomStateFromAuthResponse(authStateEnvelope, 'websocket_auth').catch((error) => {
            if (isAuthContextCancellation(error)) throw error;
            console.warn('[Classroom State] Auth snapshot failed:', safeDiagnosticError(error));
          });
          assertAuthenticatedContextCurrent(authContext, 'WebSocket classroom state');
        } else if (message.settings?.fab) {
          await applyFabSettings(message.settings.fab).catch((error) => {
            if (isAuthContextCancellation(error)) throw error;
            console.warn('[FAB] Failed to apply initial state:', safeDiagnosticError(error));
          });
          assertAuthenticatedContextCurrent(authContext, 'WebSocket FAB state');
        }
        requestClassroomStateSync('websocket-auth', true);
      }

      if (['classroom-state', 'classroom-state-sync', 'student-control-state'].includes(message.type)) {
        if (!acceptsCurrentStudentBinding(message, 'classroom state')) return;
        if (Object.prototype.hasOwnProperty.call(message, 'classroomState')) {
          await applyClassroomStateFromAuthResponse(message, 'websocket_reconcile').catch((error) => {
            console.warn('[Classroom State] WebSocket snapshot failed:', safeDiagnosticError(error));
          });
        } else {
          const snapshot = message.state || message.snapshot;
          if (!snapshot) return;
          await applyClassroomStateFromAuthResponse(
            { ...message, classroomState: snapshot },
            'websocket_reconcile',
            { authContext },
          ).catch((error) => {
            console.warn('[Classroom State] WebSocket snapshot failed:', safeDiagnosticError(error));
          });
        }
      }

      if (message.type === 'screenshot-policy-refresh') {
        if (!hasNegotiatedCapability('screenshotActiveObservationCadenceV1', authContext)) return;
        if (!acceptsCurrentStudentBinding(message, 'screenshot policy refresh', { authContext })) return;
        const teachingSessionId = String(message.teachingSessionId || '').trim();
        if (
          message.reason !== 'observation_changed'
          || !teachingSessionId
          || currentClassroomState?.teachingSessionId !== teachingSessionId
          || currentClassroomState?.supervisionContextId
        ) return;
        scheduleEventHeartbeat('screenshot-policy-refresh');
        return;
      }

      if (message.type === 'fab-state-sync' || message.type === 'fab-state') {
        if (!acceptsCurrentStudentBinding(message, 'FAB state')) return;
        const fabState = message.fabState || message.state || message.data || message;
        await applyFabSettings(fabState, { authContext, authorityEnvelope: message }).catch((error) => {
          console.warn('[FAB] WebSocket snapshot failed:', safeDiagnosticError(error));
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
          }, { authContext, authorityEnvelope: message }).catch((error) => {
            console.warn('[FAB] Session-end snapshot failed:', safeDiagnosticError(error));
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
          }, { authContext, authorityEnvelope: message }).catch((error) => {
            console.warn('[FAB] Session-end snapshot failed:', safeDiagnosticError(error));
          });
        }
      }

      // Handle global blacklist updates from server
      if (message.type === 'update-global-blacklist') {
        if (!acceptsCurrentStudentBinding(message, 'school block list update', { authContext })) return;
        const receivedGlobalBlockedDomains = message.blockedDomains || [];
        console.log('[Blacklist] Update received from server');
        
        // Apply updated blacklist rules and persist to storage
        try {
          await updateGlobalBlacklistRules(receivedGlobalBlockedDomains, {
            authContext,
            sourceMessage: message,
          });
          assertAuthenticatedContextCurrent(authContext, 'school block list update persistence');
          console.log('[Blacklist] Persisted updated blacklist to storage');

          // Notify user if blacklist was updated
          if (globalBlockedDomains.length > 0) {
            await notifyTeacherMessageForAuth({
              title: 'Website Restrictions Updated',
              message: `Your school has blocked access to: ${globalBlockedDomains.slice(0, 3).join(', ')}${globalBlockedDomains.length > 3 ? '...' : ''}`,
              priority: 1,
            }, authContext, message, `school-block-list-${Date.now()}`);
            assertAuthenticatedContextCurrent(authContext, 'school block list update notification');
          }
        } catch (error) {
          console.warn('[Blacklist] Error applying updated rules:', safeDiagnosticError(error));
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
          if (!reserveLiveViewNegotiation(negotiationId, authContext)) {
            await wsSend({
              type: 'stop-share',
              to: 'teacher',
              negotiationId,
              reason: 'duplicate-live-view-negotiation',
            }, authContext);
            return;
          }
          if (
            activeLiveViewNegotiationId
            && activeLiveViewNegotiationId !== negotiationId
          ) {
            const replacedContext = activeLiveViewContext;
            await stopScreenShare({
              reason: 'live-view-replaced',
              expectedContext: replacedContext,
            });
          }
          assertAuthenticatedContextCurrent(authContext, 'Live View replacement');
          if (
            connectionGeneration !== wsConnectionGeneration
            || !wsIdentityMatchesContext(wsTransportIdentity, authContext)
          ) {
            throw authContextSuperseded('Live View replacement transport');
          }
          const currentBinding = assertCurrentStudentBinding(
            message,
            'Live View replacement',
            { authContext },
          );
          assertBindingMatchesAuthContext(
            currentBinding,
            authContext,
            'Live View replacement',
          );
          if (
            currentClassroomState?.teachingSessionId !== teachingSessionId
            || currentClassroomState?.supervisionContextId
          ) {
            throw authContextSuperseded('Live View replacement classroom authority');
          }
          activeLiveViewNegotiationId = negotiationId;
          activeLiveViewTeachingSessionId = teachingSessionId;
          activeLiveViewContext = liveViewContextFor(authContext, negotiationId, teachingSessionId);
          liveViewTelemetryAttempts = new Set();
          await handleScreenShareRequest(
            mode,
            negotiationId,
            teachingSessionId,
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
          serverSessionEnded: true,
          pauseAutoRegistration: true,
        });
      }
      
      // Handle WebRTC offer from teacher
      if (message.type === 'offer') {
        if (!acceptsCurrentStudentBinding(message, 'live-view offer')) return;
        console.log('[WebRTC] Received offer from teacher');
        await handleOffer(
          message.sdp,
          message.from,
          String(message.negotiationId || '').trim(),
          Number(message.restartGeneration || 0),
        );
      }
      
      // Handle WebRTC ICE candidate from teacher
      if (message.type === 'ice') {
        if (!acceptsCurrentStudentBinding(message, 'live-view ICE')) return;
        console.log('[WebRTC] Received ICE candidate from teacher');
        if (message.candidate) {
          await handleIceCandidate(
            message.candidate,
            String(message.negotiationId || '').trim(),
            Number(message.restartGeneration || 0),
          );
        }
      }
      
      // Handle ping notifications
      if (message.type === 'ping') {
        if (!acceptsCurrentStudentBinding(message, 'teacher notification')) return;
        const { message: pingMessage } = message.data;
        await notifyTeacherMessageForAuth({
          title: 'Teacher Notification',
          message: pingMessage || 'Your teacher is requesting your attention',
          priority: 2,
          requireInteraction: true, // Keeps notification visible until user dismisses
        }, authContext, message, message._msgId || message.messageId || 'teacher-ping');
        assertAuthenticatedContextCurrent(authContext, 'teacher notification');
        
        // Also play a sound (beep)
        // Note: Service workers cannot play audio directly, but the notification will make a sound
      }
      
      // Handle remote control commands (Phase 1: GoGuardian-style features)
      if (message.type === 'remote-control') {
        // Binding validation deliberately precedes deduplication. A stale or
        // cross-target frame must never poison the current student's dedup set.
        if (!acceptsCurrentStudentBinding(message, 'remote-control command', {
          authContext,
          requireFullAuthority: exactTabCloseV2AuthorityRequired(message.command, authContext),
        })) return;
        const msgId = message._msgId;
        if (msgId) {
          if (recentMsgIds.has(msgId)) {
            console.log('Dedup: skipping duplicate remote-control frame');
            return;
          }
          recentMsgIds.add(msgId);
          setTimeout(() => recentMsgIds.delete(msgId), MSG_DEDUP_TTL);
        }
        await handleRemoteControl(message.command, message).catch((error) => {
          console.warn('Unhandled remote control command error:', safeDiagnosticError(error));
        });
      }
      
      // Handle chat messages (Phase 2)
      if (message.type === 'chat') {
        await handleChatMessage(message, { authContext });
      }

      // Handle teacher reply messages — send to chat thread
      // A storage-backed, identity-bound ledger deduplicates local + Redis
      // delivery as well as later heartbeat inbox retries across worker restarts.
      if (message.type === 'teacher-message') {
        await handleDurableTeacherMessage(message, { authContext }).catch((error) => {
          console.warn('Teacher message delivery failed:', safeDiagnosticError(error));
        });
      }

      // Handle teacher closing the chat
      // Dedup: local + Redis both deliver the same message
      if (message.type === 'chat-closed') {
        if (!acceptsCurrentStudentBinding(message, 'chat close', { authContext })) return;
        if (!messageMatchesActiveFabSession(message)) {
          console.warn('[FAB] Ignoring chat close for an inactive teaching session');
          return;
        }
        const dedupKey = message._msgId || ('cc:' + Date.now().toString().slice(0, -3));
        if (!recentMsgIds.has(dedupKey)) {
          recentMsgIds.add(dedupKey);
          setTimeout(() => recentMsgIds.delete(dedupKey), MSG_DEDUP_TTL);
          try {
            await broadcastToAllTabsForAuth('chat-closed', {
              sessionId: message.sessionId,
              studentId: message.studentId,
            }, authContext, message);
            assertAuthenticatedContextCurrent(authContext, 'chat close broadcast');
          } catch (error) {
            recentMsgIds.delete(dedupKey);
            throw error;
          }
        }
      }

      // Handle check-in requests (Phase 3)
      if (message.type === 'check-in-request') {
        if (!acceptsCurrentStudentBinding(message, 'check-in request', { authContext })) return;
        await handleCheckInRequest(message, { authContext });
      }

      // ====================================
      // TEACHER BROADCAST (Receiving teacher's screen)
      // ====================================

      // Teacher started broadcasting - request to join
      if (message.type === 'teacher-broadcast-start') {
        if (!acceptsCurrentStudentBinding(message, 'teacher broadcast start', { authContext })) return;
        console.log('[Broadcast] Teacher started broadcasting, requesting to join');
        await handleBroadcastStart(message, authContext);
      }

      // Teacher stopped broadcasting
      if (message.type === 'teacher-broadcast-stop') {
        if (!acceptsCurrentStudentBinding(message, 'teacher broadcast stop', { authContext })) return;
        console.log('[Broadcast] Teacher stopped broadcasting');
        await handleBroadcastStop(message, authContext);
      }

      // Received broadcast offer from teacher
      if (message.type === 'broadcast-offer') {
        if (!acceptsCurrentStudentBinding(message, 'teacher broadcast offer', { authContext })) return;
        console.log('[Broadcast] Received offer from teacher');
        await handleBroadcastOffer(message, authContext);
      }

      // Received ICE candidate for broadcast
      if (message.type === 'broadcast-ice') {
        if (!acceptsCurrentStudentBinding(message, 'teacher broadcast ICE', { authContext })) return;
        console.log('[Broadcast] Received ICE candidate from teacher');
        if (message.candidate) {
          handleBroadcastIce(message, authContext);
        }
      }
    } catch (error) {
      if (isAuthContextCancellation(error)) {
        console.info('[WebSocket] Discarded a frame for a retired authentication context');
        return;
      }
      console.warn('Error processing WebSocket message:', safeDiagnosticError(error));
    }
}

// Tab change listener - send immediate heartbeat when user switches tabs
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  let navigationAuthContext = null;
  try {
    navigationAuthContext = captureAuthenticatedContext('tab activation');
  } catch {
    // Auth-gate enforcement still runs below for configured signed-out tabs.
  }
  await classroomStateRestorePromise;
  enforceAuthGateForTab(activeInfo.tabId).catch(() => {});
  if (!navigationAuthContext) return;
  try {
    assertAuthenticatedContextCurrent(navigationAuthContext, 'tab activation');
  } catch {
    return;
  }
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    assertAuthenticatedContextCurrent(navigationAuthContext, 'tab activation');
    await observeRestrictionSsoHostForAuth(tab.url, navigationAuthContext).catch((error) => {
      if (!isAuthContextCancellation(error)) {
        console.warn('[Restriction SSO] Activation persistence deferred:', safeDiagnosticError(error));
      }
    });
    assertAuthenticatedContextCurrent(navigationAuthContext, 'tab activation');
    // Allow both ACTIVE and IDLE states (user switching tabs means they're present)
    if (trackingState === TRACKING_STATES.OFF) return;
    queueNavigationEvent('tab_change', tab.url, tab.title || 'No title', { tabId: activeInfo.tabId });
    // Send immediate heartbeat to update teacher dashboard quickly
    scheduleEventHeartbeat('tab-activated');
    scheduleActiveViewNavigationCapture('tab-activated');
  } catch (error) {
    console.warn('Failed to read active tab info:', safeDiagnosticError(error));
  }
});

// Tab update listener - send heartbeat on URL/title change
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  let navigationAuthContext = null;
  try {
    navigationAuthContext = captureAuthenticatedContext('tab update');
  } catch {
    // Auth-gate enforcement still runs below for configured signed-out tabs.
  }
  try {
    await classroomStateRestorePromise;
    if (changeInfo.status === 'complete') {
      enforceAuthGateForTab(tab).catch(() => {});
    }
    if (!navigationAuthContext) return;
    assertAuthenticatedContextCurrent(navigationAuthContext, 'tab update');
    if (changeInfo.url) {
      await observeRestrictionSsoHostForAuth(changeInfo.url, navigationAuthContext).catch((error) => {
        if (!isAuthContextCancellation(error)) {
          console.warn('[Restriction SSO] Tab visit persistence deferred:', safeDiagnosticError(error));
        }
      });
      assertAuthenticatedContextCurrent(navigationAuthContext, 'tab update');
    }
    // Allow both ACTIVE and IDLE states
    if (trackingState === TRACKING_STATES.OFF) return;
    if (!tab.active || !(changeInfo.url || changeInfo.title)) return;
    if (changeInfo.url) {
      queueNavigationEvent('url_change', changeInfo.url, tab.title || 'No title', { tabId });
      // Send immediate heartbeat to update teacher dashboard quickly
      scheduleEventHeartbeat('url-changed');
      scheduleActiveViewNavigationCapture('url-changed');
    }
  } catch (error) {
    console.warn('[Service Worker] Tab updated handler error:', safeDiagnosticError(error));
  }
});

// Window focus change listener - detect when user switches windows or leaves Chrome
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (trackingState === TRACKING_STATES.OFF) return;

  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // User switched to a different application (not Chrome)
    // Send heartbeat with current state - teacher will see last known tab
    scheduleEventHeartbeat('window-unfocused');
  } else {
    // User focused a Chrome window - get the active tab in that window
    try {
      const tabs = await chrome.tabs.query({ active: true, windowId });
      if (tabs.length > 0 && tabs[0].url?.startsWith('http')) {
        scheduleEventHeartbeat('window-focused');
      }
    } catch (error) {
      console.warn('Failed to query focused window tabs:', safeDiagnosticError(error));
    }
  }
});

function handleCameraStatusChanged(message = {}, sender = {}) {
  if (
    !studentMessageContextIsCurrent(message.studentMessageContext)
    || !Number.isInteger(sender?.tab?.id)
  ) {
    return { success: false, ignored: true };
  }
  if (message.cameraActive === true) cameraActiveTabs.add(sender.tab.id);
  else cameraActiveTabs.delete(sender.tab.id);
  cameraActive = cameraActiveTabs.size > 0;
  scheduleEventHeartbeat('camera-status');
  return { success: true, cameraActive };
}

async function getStudentSessionUiState(message = {}) {
  if (
    !hasSessionStorage()
    || !studentMessageContextIsCurrent(message.studentMessageContext)
  ) return { success: false };
  const authContext = captureAuthenticatedContext('student session UI state');
  const expectedFabBinding = fabIdentityBinding();
  const allowedKeys = [
    'handRaised',
    'messagingEnabled',
    'handRaisingEnabled',
    'fabChatMessages',
    'fabChatClosed',
    FAB_STATE_STORAGE_KEY,
    FAB_CONTEXT_STORAGE_KEY,
    FAB_CHAT_CONTEXT_STORAGE_KEY,
  ];
  const stored = await durableSessionKv.get(allowedKeys);
  assertAuthenticatedContextCurrent(authContext, 'student session UI state');
  if (
    !studentMessageContextIsCurrent(message.studentMessageContext)
    || fabIdentityBinding() !== expectedFabBinding
  ) return { success: false };
  return {
    success: true,
    stored: Object.fromEntries(allowedKeys.flatMap((key) => (
      Object.prototype.hasOwnProperty.call(stored, key) ? [[key, stored[key]]] : []
    ))),
    fabBinding: expectedFabBinding,
  };
}

// Listen for messages from popup
async function updateServerOriginForSignedOutProfile(rawServerUrl) {
  const newServerUrl = normalizedServerOrigin(rawServerUrl);
  if (!newServerUrl) {
    const error = new Error('Invalid server URL');
    error.code = 'INVALID_SERVER_URL';
    throw error;
  }
  return enqueueStudentAuthMutation(async () => {
    const currentServerUrl = normalizedServerOrigin(CONFIG.serverUrl);
    const originChanged = currentServerUrl !== newServerUrl;
    if (originChanged && hasStudentAuth()) {
      const error = new Error('Sign out before changing the ClassPilot server');
      error.code = 'AUTH_CONTEXT_SERVER_CHANGE_REQUIRES_SIGN_OUT';
      throw error;
    }
    if (originChanged) await clearRestrictionSsoVisitState();
    CONFIG.serverUrl = newServerUrl;
    // The cached login-config (incl. kiosk schoolId/availability) came from the
    // old server — drop it so kiosk URLs never mix origins and configs.
    resetSharedSignInLoginConfigCache();
    await rawLocalKv.set({ config: persistedNonAuthConfig(CONFIG) });
    console.log('[Config] Server origin updated');
    // Refresh school settings and tracking state with the new server URL.
    refreshSchoolSettings({ force: true }).then(() => {
      updateTrackingState('server-url-update');
    }).catch(() => {});
    return { success: true };
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'student-auth-gate-presence') {
    sendResponse({ success: noteStudentAuthGatePresence(message, sender) });
    return true;
  }

  if (message.type === 'record-auth-gate-timing') {
    if (!Number.isInteger(sender.tab?.id)) {
      sendResponse({ success: false });
      return true;
    }
    trustedLocalStorageAccessPromise
      .then(() => persistContentAuthGateTiming(message.timing))
      .then(
        () => sendResponse({ success: true }),
        () => sendResponse({ success: false }),
      );
    return true;
  }

  if (message.type === 'get-student-message-context') {
    try {
      const authContext = captureAuthenticatedContext('student content context');
      const activeSessionIds = activeTeachingSessionIds();
      const preferredSessionId = String(
        currentFabState?.teachingSessionId || currentClassroomState?.teachingSessionId || '',
      ).trim();
      sendResponse({
        success: true,
        studentMessageContext: studentMessageContextFor(authContext),
        fabBinding: fabIdentityBinding(),
        activeTeachingSessionIds: activeSessionIds,
        activeTeachingSessionId: activeSessionIds.includes(preferredSessionId)
          ? preferredSessionId
          : activeSessionIds.length === 1 ? activeSessionIds[0] : null,
      });
    } catch {
      sendResponse({ success: false });
    }
    return true;
  }

  if (message.type === 'validate-student-message-context') {
    sendResponse({
      success: true,
      current: studentMessageContextIsCurrent(message.studentMessageContext),
      fabBinding: fabIdentityBinding(),
      activeTeachingSessionIds: activeTeachingSessionIds(),
    });
    return true;
  }

  if (message.type === 'get-student-session-ui-state') {
    getStudentSessionUiState(message).then(
      (result) => sendResponse(result),
      () => sendResponse({ success: false }),
    );
    return true;
  }

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
          console.warn('Failed to refresh tab:', safeDiagnosticError(error));
        }
        
        sendResponse({ success: true, data });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Will respond asynchronously
  }
  
  if (message.type === 'get-config') {
    sendResponse({ config: getPublishablePopupConfig() });
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
    let actionRequest;
    try {
      actionRequest = captureStudentActionRequest(message, 'message inbox read');
    } catch {
      sendResponse({ success: false, error: 'Messages unavailable' });
      return true;
    }
    classroomStateRestorePromise
      .then(() => {
        assertStudentActionRequestCurrent(actionRequest, 'message inbox read');
        return getCurrentMessageInbox({
          authContext: actionRequest.authContext,
          expectedBinding: monitoringEventAuthBindingForContext(actionRequest.authContext),
        });
      })
      .then((messages) => {
        assertStudentActionRequestCurrent(actionRequest, 'message inbox read completion');
        sendResponse({ success: true, messages });
      })
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Messages unavailable' }));
    return true;
  }

  if (message.type === 'mark-message-inbox-read') {
    let actionRequest;
    try {
      actionRequest = captureStudentActionRequest(message, 'message inbox read state');
    } catch {
      sendResponse({ success: false, error: 'Messages unavailable' });
      return true;
    }
    classroomStateRestorePromise
      .then(() => {
        assertStudentActionRequestCurrent(actionRequest, 'message inbox read state');
        return markCurrentMessageInboxRead({
          authContext: actionRequest.authContext,
          expectedBinding: monitoringEventAuthBindingForContext(actionRequest.authContext),
        });
      })
      .then((messages) => {
        assertStudentActionRequestCurrent(actionRequest, 'message inbox read state completion');
        sendResponse({ success: true, messages });
      })
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Messages unavailable' }));
    return true;
  }

  if (message.type === 'clear-message-inbox-display') {
    let actionRequest;
    try {
      actionRequest = captureStudentActionRequest(message, 'message inbox clear');
    } catch {
      sendResponse({ success: false, error: 'Messages unavailable' });
      return true;
    }
    classroomStateRestorePromise
      .then(() => {
        assertStudentActionRequestCurrent(actionRequest, 'message inbox clear');
        return clearCurrentMessageInboxDisplay({
          authContext: actionRequest.authContext,
          expectedBinding: monitoringEventAuthBindingForContext(actionRequest.authContext),
        });
      })
      .then(() => {
        assertStudentActionRequestCurrent(actionRequest, 'message inbox clear completion');
        sendResponse({ success: true });
      })
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Messages unavailable' }));
    return true;
  }

  if (message.type === 'persist-fab-chat-state') {
    let actionRequest;
    try {
      actionRequest = captureStudentActionRequest(message, 'FAB chat state request');
    } catch {
      sendResponse({ success: false, ignored: true });
      return true;
    }
    persistFabChatStateForRequest(message, actionRequest)
      .then(() => {
        assertStudentActionRequestCurrent(actionRequest, 'FAB chat state request completion');
        sendResponse({ success: true });
      })
      .catch(() => sendResponse({ success: false, ignored: true }));
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
    let snapshotRequest;
    try {
      snapshotRequest = captureStudentIdentityRequest(message, 'classroom UI snapshot request');
    } catch {
      sendResponse({ success: false, error: 'Overlay state unavailable' });
      return true;
    }
    getClassroomUiSnapshotForAuth(
      snapshotRequest.authContext,
      'classroom UI snapshot request',
    )
      .then((snapshot) => {
        assertAuthenticatedContextCurrent(
          snapshotRequest.authContext,
          'classroom UI snapshot response',
        );
        sendResponse({ success: true, ...snapshot });
      })
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Overlay state unavailable' }));
    return true;
  }

  if (message.type === 'request-kiosk-launch') {
    let responseGuard;
    authStateRestorePromise
      .then(() => awaitManagedAuthGatePolicyStable())
      .then(() => {
        responseGuard = captureKioskLaunchGuard();
        return requestKioskLaunchUrl({ guard: responseGuard });
      })
      .then((url) => {
        if (!kioskLaunchGuardIsCurrent(responseGuard) || !url || !isKioskGateUrl(url)) {
          sendResponse({ success: false, error: 'PassPilot kiosk is unavailable' });
          return;
        }
        const parsed = new URL(url);
        sendResponse({
          success: true,
          url,
          continuity: parsed.hash.startsWith('#launchTicket='),
          launchGuard: publishableKioskLaunchGuard(responseGuard),
        });
      })
      .catch(() => sendResponse({ success: false, error: 'PassPilot kiosk is unavailable' }));
    return true;
  }

  if (message.type === 'validate-kiosk-launch') {
    sendResponse({
      success: true,
      current: kioskLaunchValidationIsCurrent(message.launchGuard, message.url),
    });
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
          sendResponse(response);
        })
        .catch(async (error) => {
          try {
            const response = {
              success: false,
              error: error?.message || 'Managed policy revalidation failed',
              state: await getPublishableAuthGateState(),
            };
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
        return fetchLoginRosterForGate({
          gradeLevel: message.gradeLevel,
          forceRefresh: message.forceRefresh === true,
          forceRecovery: message.forceRecovery === true,
        });
      })
      .then((data) => sendResponse(data))
      .catch((error) => sendResponse({ success: false, error: error.message || 'Could not load roster' }));
    return true;
  }

  if (message.type === 'manual-student-login') {
    manualStudentLogin(message.payload || {})
      .then((data) => sendResponse(data))
      .catch((error) => {
        const failure = {
          success: false,
          error: error.message || 'Invalid student credentials',
        };
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) {
          failure.status = error.status;
        }
        if (/^[A-Z][A-Z0-9_]{0,127}$/.test(String(error?.code || ''))) {
          failure.code = error.code;
        }
        sendResponse(failure);
      });
    return true;
  }

  if (message.type === 'student-sign-out') {
    // 2.6.8: a deliberate sign-out ALWAYS parks the device at the gate. The
    // pause was previously conditional on isManualIdentitySource(), so a
    // chrome_profile student (or a sign-out racing an already-cleared
    // identity) left auto-registration enabled and the next worker wake —
    // the 5-minute 'wake-up' alarm — silently signed the student back in.
    let signOutRequest;
    try {
      signOutRequest = captureStudentIdentityRequest(message, 'student sign out');
    } catch {
      sendResponse({ success: false, error: 'The signed-in student changed. Please try again.' });
      return true;
    }
    clearStudentAuth('explicit_sign_out', {
      notifyBackend: true,
      awaitBackendSignOut: true,
      preserveRecoveryForGate: true,
      pauseAutoRegistration: true,
      expectedAuthContext: signOutRequest.authContext,
    })
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message || 'Could not sign out' }));
    return true;
  }

  // Handle poll response from content script
  if (message.type === 'poll-response') {
    const { pollId, selectedOption } = message;
    console.log('[Poll] Response received');

    (async () => {
      const actionRequest = captureStudentActionRequest(message, 'poll response');
      assertStudentActionRequestCurrent(actionRequest, 'poll response');
      const overlays = await getRestorableClassroomOverlayState({
        authContext: actionRequest.authContext,
        expectedBinding: actionRequest.fabBinding,
      });
      assertStudentActionRequestCurrent(actionRequest, 'poll response overlay read');
      if (
        !overlays.poll
        || overlays.poll.pollId !== pollId
        || overlays.poll.teachingSessionId !== actionRequest.sessionId
      ) {
        throw new Error('This poll is no longer active for the signed-in student');
      }
      const option = Number(selectedOption);
      if (!Number.isSafeInteger(option) || option < 0 || option >= overlays.poll.options.length) {
        throw new Error('Invalid poll option');
      }
      assertStudentActionRequestCurrent(actionRequest, 'poll response transmission');
      const response = await fetchWithBackoff(`${actionRequest.authContext.serverOrigin}/api/polls/${encodeURIComponent(pollId)}/respond`, {
        method: 'POST',
        headers: buildDeviceAuthHeaders(actionRequest.authContext),
        body: JSON.stringify({
          deviceId: actionRequest.authContext.deviceId,
          studentId: actionRequest.authContext.studentId,
          studentSessionId: actionRequest.authContext.studentSessionId,
          teachingSessionId: actionRequest.sessionId,
          selectedOption: option,
        }),
        signal: actionRequest.authContext.signal,
      }, {
        context: 'poll response',
        maxAttempts: 2,
        respectGlobalBackoff: false,
      });
      assertStudentActionRequestCurrent(actionRequest, 'poll response result');
      const data = await response.json().catch(() => ({}));
      assertStudentActionRequestCurrent(actionRequest, 'poll response body');
      if (!response.ok) {
        throw buildResponseError(response, data, response.status === 409
          ? 'A response was already recorded for this poll'
          : 'Could not submit poll response');
      }
      await markPollResponsePersisted(pollId, option, actionRequest.authContext);
      assertStudentActionRequestCurrent(actionRequest, 'poll response persistence');
      await broadcastToAllTabsForAuth(
        'poll-response-succeeded',
        { pollId, selectedOption: option, teachingSessionId: actionRequest.sessionId },
        actionRequest.authContext,
        {
          studentId: actionRequest.authContext.studentId,
          studentSessionId: actionRequest.authContext.studentSessionId,
        },
      );
      assertStudentActionRequestCurrent(actionRequest, 'poll response completion');
      console.log('[Poll] Response submitted');
      return data;
    })()
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => {
        console.warn('Failed to submit poll response:', safeDiagnosticError(error));
        sendResponse({ success: false, error: error?.message || 'Could not submit poll response' });
      });
    return true;
  }

  // Handle raise hand from popup
  if (message.type === 'raise-hand') {
    console.log('Raise hand requested');
    (async () => {
      const actionRequest = captureStudentActionRequest(message, 'raise hand');
      assertStudentActionRequestCurrent(actionRequest, 'raise hand');
      const response = await fetchWithBackoff(`${actionRequest.authContext.serverOrigin}/api/student/raise-hand`, {
        method: 'POST',
        headers: buildDeviceAuthHeaders(actionRequest.authContext),
        body: JSON.stringify({
          deviceId: actionRequest.authContext.deviceId,
          studentId: actionRequest.authContext.studentId,
          studentSessionId: actionRequest.authContext.studentSessionId,
          teachingSessionId: actionRequest.sessionId,
        }),
        signal: actionRequest.authContext.signal,
      }, {
        context: 'raise hand',
        maxAttempts: 2,
        respectGlobalBackoff: false,
      });
      assertStudentActionRequestCurrent(actionRequest, 'raise hand response');
      const data = await parseJsonResponse(response);
      assertStudentActionRequestCurrent(actionRequest, 'raise hand response body');
      await updateLocalFabHandRaised(true, 'student-raised-hand', {
        authContext: actionRequest.authContext,
      });
      assertStudentActionRequestCurrent(actionRequest, 'raise hand completion');
      console.log('[FAB] Hand raised');
      return data;
    })().then((data) => sendResponse({ success: true, data })).catch((err) => {
      console.warn('Failed to raise hand:', safeDiagnosticError(err));
      sendResponse({ success: false, error: 'Could not raise hand' });
    });

    return true;
  }

  // Handle lower hand from popup
  if (message.type === 'lower-hand') {
    console.log('Lower hand requested');
    (async () => {
      const actionRequest = captureStudentActionRequest(message, 'lower hand');
      assertStudentActionRequestCurrent(actionRequest, 'lower hand');
      const response = await fetchWithBackoff(`${actionRequest.authContext.serverOrigin}/api/student/lower-hand`, {
        method: 'POST',
        headers: buildDeviceAuthHeaders(actionRequest.authContext),
        body: JSON.stringify({
          deviceId: actionRequest.authContext.deviceId,
          studentId: actionRequest.authContext.studentId,
          studentSessionId: actionRequest.authContext.studentSessionId,
          teachingSessionId: actionRequest.sessionId,
        }),
        signal: actionRequest.authContext.signal,
      }, {
        context: 'lower hand',
        maxAttempts: 2,
        respectGlobalBackoff: false,
      });
      assertStudentActionRequestCurrent(actionRequest, 'lower hand response');
      const data = await parseJsonResponse(response);
      assertStudentActionRequestCurrent(actionRequest, 'lower hand response body');
      await updateLocalFabHandRaised(false, 'student-lowered-hand', {
        authContext: actionRequest.authContext,
      });
      assertStudentActionRequestCurrent(actionRequest, 'lower hand completion');
      console.log('[FAB] Hand lowered');
      return data;
    })().then((data) => sendResponse({ success: true, data })).catch((err) => {
      console.warn('Failed to lower hand:', safeDiagnosticError(err));
      sendResponse({ success: false, error: 'Could not lower hand' });
    });

    return true;
  }

  // Handle send message from popup (two-way chat)
  if (message.type === 'send-student-message') {
    let actionRequest;
    try {
      actionRequest = captureStudentActionRequest(message, 'student message request');
    } catch (error) {
      sendResponse({
        success: false,
        error: 'Student changed before the message could be sent',
        errorCode: error?.code || 'AUTH_CONTEXT_SUPERSEDED',
      });
      return true;
    }
    queueAndSendStudentChatMessage({
      clientMessageId: message.clientMessageId,
      message: message.message,
      messageType: message.messageType,
      sessionId: actionRequest.sessionId,
    }, actionRequest.authContext).then((result) => {
      assertStudentActionRequestCurrent(actionRequest, 'student message request completion');
      sendResponse(result);
    }).catch((error) => {
      if (isAuthContextCancellation(error)) {
        sendResponse({
          success: false,
          error: 'Student changed while sending the message',
          errorCode: 'AUTH_CONTEXT_SUPERSEDED',
        });
        return;
      }
      sendResponse({
        success: false,
        error: error?.message || 'Message could not be queued',
        errorCode: error?.code || 'STUDENT_CHAT_FAILED',
      });
    });

    return true;
  }

  if (message.type === 'update-server-url') {
    updateServerOriginForSignedOutProfile(message.serverUrl)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        success: false,
        error: error?.message || 'Could not update the ClassPilot server',
        errorCode: error?.code,
      }));
    return true;
  }
  
  if (message.type === 'student-changed') {
    const requestedStudentId = String(message.studentId || '').trim();
    if (requestedStudentId && requestedStudentId === CONFIG.activeStudentId) {
      sendResponse({ success: true, unchanged: true });
      return true;
    }
    // A student ID cannot be replaced independently of its token and session.
    // The popup's historical selector did exactly that, allowing work captured
    // for one student to be relabelled as another. Require the atomic sign-in
    // flow to establish a fresh immutable authentication context instead.
    sendResponse({
      success: false,
      error: 'Sign out and sign in as the selected student',
      errorCode: 'STUDENT_CHANGE_REQUIRES_SIGN_IN',
    });
    return true;
  }
  
  if (message.type === 'camera-status-changed') {
    sendResponse(handleCameraStatusChanged(message, sender));
    return true;
  }
});

console.log('ClassPilot service worker loaded');
