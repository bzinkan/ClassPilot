import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

function readRepoFile(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function optionsAround(source: string, context: string) {
  const marker = `context: '${context}'`;
  const index = source.indexOf(marker);
  expect(index, `${context} options block should exist`).toBeGreaterThan(-1);
  return source.slice(Math.max(0, index - 200), index + 220);
}

describe("ClassPilot extension release package guards", () => {
  it("bumps the extension manifest to the pre-upload version", () => {
    const manifest = JSON.parse(readRepoFile("extension/manifest.json"));
    expect(manifest.version).toBe("2.6.0");
    expect(manifest.storage?.managed_schema).toBe("managed_schema.json");
  });

  it("uses a 10 second fallback delay for rate-limit retries", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toContain("const API_RETRY_RATE_LIMIT_DELAY_MS = 10000;");
    expect(serviceWorker).toContain("const isRateLimited = response?.status === 429;");
    expect(serviceWorker).toContain(
      "const baseRetryDelayMs = isRateLimited ? API_RETRY_RATE_LIMIT_DELAY_MS : API_RETRY_BASE_DELAY_MS;"
    );
  });

  it("does not block user-facing actions behind the telemetry backoff gate", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    for (const context of [
      "student sign-out",
      "login roster",
      "student login",
      "poll response",
      "raise hand",
      "lower hand",
      "student message",
    ]) {
      expect(optionsAround(serviceWorker, context)).toContain("respectGlobalBackoff: false");
    }
  });

  it("keeps background telemetry respecting global backoff", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    for (const context of [
      "device heartbeat",
      "screenshot upload",
      "student registration",
      "device event",
    ]) {
      expect(optionsAround(serviceWorker, context)).not.toContain("respectGlobalBackoff: false");
    }
  });

  it("stops writing the legacy unscoped device event endpoint", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).not.toContain("/api/device/event");
    expect(serviceWorker).toContain("/api/classpilot/device/events");
    expect(serviceWorker).toContain("RuntimeCore.acknowledgedMonitoringEventIds(batch, data)");
    const scheduleStart = serviceWorker.indexOf("function scheduleMonitoringEventFlush");
    const scheduleEnd = serviceWorker.indexOf("function enqueueMonitoringEvent", scheduleStart);
    const scheduleBody = serviceWorker.slice(scheduleStart, scheduleEnd);
    expect(scheduleBody).toContain("if (!monitoringEventFlushTimer)");
    expect(scheduleBody).not.toContain("clearTimeout(monitoringEventFlushTimer)");
  });

  it("uses the serialized half-open DNR composer without broad rule deletion", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const runtimeCore = readRepoFile("extension/classroom-runtime-core.js");
    expect(serviceWorker).toContain("composeAllManagedDynamicRules");
    expect(serviceWorker).not.toContain("existingRules.map(rule => rule.id)");
    expect(runtimeCore).toContain("school: Object.freeze([1000, 2000])");
    expect(runtimeCore).toContain("teacher: Object.freeze([2000, 3000])");
    expect(runtimeCore).toContain("temporary: Object.freeze([3000, 4000])");
  });

  it("reconciles already-open tabs inside the serialized full-state application", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const runtimeCore = readRepoFile("extension/classroom-runtime-core.js");
    const runtimeStart = serviceWorker.indexOf("async function setRuntimeFromClassroomState");
    const runtimeEnd = serviceWorker.indexOf("async function resolveCurrentUrlMarker", runtimeStart);
    const runtimeBody = serviceWorker.slice(runtimeStart, runtimeEnd);
    expect(runtimeBody).toContain("await composeAllManagedDynamicRules()");
    expect(runtimeBody).toContain("await reconcileClassroomStateTabsBestEffort(state)");
    expect(runtimeBody).toContain("DNR is the durable enforcement boundary");
    expect(serviceWorker).toContain("CLASSROOM_STATE_RECONCILE_ALARM");
    expect(serviceWorker).toContain("Existing-tab reconciliation deferred");
    expect(serviceWorker).toContain("if (globalBlockedDomainsStateTrusted) ranges.push('school')");
    expect(serviceWorker).toContain("hasOwnProperty.call(stored, 'globalBlockedDomains')");
    expect(runtimeCore).toContain("function planClassroomTabReconciliation");
    expect(runtimeCore).toContain("isProtectedInternalTab");
  });

  it("uses prior-day attribution for overnight tracking windows", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const runtimeCore = readRepoFile("extension/classroom-runtime-core.js");
    expect(serviceWorker).toContain("RuntimeCore.isWithinTrackingWindow");
    expect(runtimeCore).toContain("end > start");
    expect(runtimeCore).toContain("activeDays.has(previousWeekday)");
  });

  it("restores revisioned teacher state instead of clearing it on worker auth", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toContain("classroomControlStateV1");
    expect(serviceWorker).toContain("requestClassroomStateSync('worker-wake', true)");
    expect(serviceWorker).not.toContain("Clearing teacher block list on new auth");
    expect(serviceWorker).not.toContain("Cleared stale teacher block list state");
  });

  it("applies classroom state returned by every supported student login path", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toContain("async function applyClassroomStateFromAuthResponse");
    expect(serviceWorker).toContain("await applyClassroomState(snapshot, { reason })");
    expect(serviceWorker).toContain("emitEvent: false");
    expect(serviceWorker).toContain("CLASSROOM_STATE_STUDENT_BINDING_KEY");
    expect(serviceWorker).toContain("applyClassroomStateFromAuthResponse(data, 'student_login')");
    expect(
      serviceWorker.match(/applyClassroomStateFromAuthResponse\(data, 'student_registration'\)/g)
    ).toHaveLength(2);
  });

  it("reports protocol capability and preserves the independent recovery expiry", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toContain("extensionVersion: chrome.runtime.getManifest().version");
    expect(serviceWorker).toContain("chromeVersion: currentChromiumVersion()");
    expect(serviceWorker).toContain("classroomStateSupervisionContextId:");
    expect(serviceWorker).toContain("CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY");
    expect(serviceWorker).toContain("[CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]: normalized.hardExpiresAt");
    expect(serviceWorker).not.toContain("storedFailSafeExpiryAt || Date.now() + CLASSROOM_STATE_MAX_LIFETIME_MS");
    expect(serviceWorker).toContain("function scheduleClassroomStateExpiryRetry()");
    expect(serviceWorker).toContain("CLASSROOM_STATE_EXPIRY_RETRY_MS");
    expect(serviceWorker).toContain("scheduleClassroomStateExpiryRetry();");
    expect(serviceWorker).toContain("const stateWithoutExpiredAllows = {");
  });

  it("treats explicit-null auth, heartbeat, and WebSocket state as authoritative", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toContain("applyClassroomStateFromAuthResponse(data, 'heartbeat_reconcile')");
    expect(serviceWorker).toContain("Object.prototype.hasOwnProperty.call(message, 'classroomState')");
    expect(serviceWorker).toContain("applyClassroomStateFromAuthResponse(message, 'websocket_reconcile')");
    expect(serviceWorker).toContain("reason: `${reason}_no_state`");
  });

  it("persists monitoring transitions and flushes OFF before disconnect", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toContain("const MONITORING_STATE_STORAGE_KEY = 'monitoringStateV1';");
    expect(serviceWorker).toContain("await kv.set({ [MONITORING_STATE_STORAGE_KEY]: persistedMonitoringState })");
    expect(serviceWorker).toContain(
      "trackingState === nextState && persistedMonitoringState.state === nextState"
    );
    expect(serviceWorker).toContain("await flushMonitoringEventOutbox()");
    expect(serviceWorker).toContain("reason: 'scope_initialized'");
    const disableStart = serviceWorker.indexOf("async function disableForInactiveLicense");
    const disableEnd = serviceWorker.indexOf("async function checkLicenseStatus", disableStart);
    const disableBody = serviceWorker.slice(disableStart, disableEnd);
    expect(disableBody.indexOf("transitionTrackingState(TRACKING_STATES.OFF"))
      .toBeLessThan(disableBody.indexOf("disconnectWebSocket()"));
  });

  it("uses persisted heartbeat health and a worker-safe 60-second alarm", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const runtimeCore = readRepoFile("extension/classroom-runtime-core.js");
    expect(serviceWorker).toContain("const CONNECTIVITY_HEALTH_STORAGE_KEY = 'connectivityHealthV1';");
    expect(serviceWorker).toContain("const CONNECTIVITY_HEALTH_ALARM_NAME = 'connectivity-health-boundary';");
    expect(serviceWorker).toContain("chrome.alarms.create(CONNECTIVITY_HEALTH_ALARM_NAME");
    expect(serviceWorker).toContain("School server unreachable");
    expect(serviceWorker).toContain("requestClassroomStateSync('heartbeat-recovery', true)");
    expect(runtimeCore).toContain("const CONNECTIVITY_UNREACHABLE_AFTER_MS = 60 * 1000;");
    expect(serviceWorker).not.toContain("navigator.onLine");
  });

  it("rejects expired transient commands before acknowledgement or execution", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const handlerStart = serviceWorker.indexOf("async function handleRemoteControl");
    const handlerEnd = serviceWorker.indexOf("async function executeRemoteControlCommand", handlerStart);
    const handler = serviceWorker.slice(handlerStart, handlerEnd);
    expect(handler).toContain("RuntimeCore.commandDeliveryState");
    expect(handler).toContain("sendCommandAck(commandId, 'expired'");
    expect(handler.indexOf("if (delivery.expired)"))
      .toBeLessThan(handler.indexOf("sendCommandAck(commandId, 'received'"));
    expect(handler.indexOf("if (delivery.expired)"))
      .toBeLessThan(handler.indexOf("executeRemoteControlCommand"));
  });

  it("stores screenshot diagnostics but never screenshot bodies", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const persistStart = serviceWorker.indexOf("async function persistScreenshotHealth");
    const persistEnd = serviceWorker.indexOf("function isHttpUrl", persistStart);
    const persistence = serviceWorker.slice(persistStart, persistEnd);
    expect(serviceWorker).toContain("const SCREENSHOT_HEALTH_STORAGE_KEY = 'screenshotHealthV1';");
    expect(persistence).toContain("RuntimeCore.normalizeScreenshotHealth");
    expect(persistence).not.toContain("dataUrl");
    expect(persistence).not.toContain("base64");
    expect(persistence).not.toContain("jpeg");
  });

  it("keeps the teacher-message inbox bounded, persistent, and student-bound", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const runtimeCore = readRepoFile("extension/classroom-runtime-core.js");
    const popup = readRepoFile("extension/popup.js");
    expect(serviceWorker).toContain("const MESSAGE_INBOX_BINDING_KEY = 'messageInboxAuthBindingV1';");
    expect(serviceWorker).toContain("const MESSAGE_INBOX_DEDUP_KEY = 'messageInboxSeenIdsV1';");
    expect(serviceWorker).toContain("persistHeartbeatPendingMessages(");
    expect(serviceWorker).toContain("heartbeatMessageBinding");
    expect(serviceWorker).toContain("options.expectedBinding !== identity.binding");
    expect(serviceWorker).toMatch(/persistHeartbeatPendingMessages\(\s*data\.pendingMessages,\s*heartbeatMessageBinding\s*\)/);
    const sendHeartbeatStart = serviceWorker.indexOf("async function sendHeartbeat(");
    const responseBindingGuard = serviceWorker.indexOf(
      "heartbeatMessageBinding !== currentHeartbeatBinding",
      sendHeartbeatStart
    );
    const heartbeatSuccess = serviceWorker.indexOf("await recordHeartbeatSuccess()", sendHeartbeatStart);
    const classroomResponseApply = serviceWorker.indexOf(
      "await applyClassroomStateFromAuthResponse(data, 'heartbeat_reconcile')",
      sendHeartbeatStart
    );
    expect(responseBindingGuard).toBeGreaterThan(sendHeartbeatStart);
    expect(responseBindingGuard).toBeLessThan(heartbeatSuccess);
    expect(responseBindingGuard).toBeLessThan(classroomResponseApply);
    expect(serviceWorker).toContain("safeSendHeartbeat('identity-changed-reconcile')");
    expect(serviceWorker).toContain("await clearStudentMessageState(reason)");
    expect(serviceWorker).toContain("await reconcileMessageInboxIdentity('worker-wake')");
    expect(runtimeCore).toContain("const MAX_MESSAGE_INBOX_ENTRIES = 50;");
    expect(runtimeCore).toContain("const MAX_MESSAGE_DEDUP_IDS = 500;");
    expect(popup).toContain("type: 'get-message-inbox'");
    expect(popup).not.toContain("chrome.storage.local.get(['messages'])");
  });

  it("keeps the monitoring indicator tooltip reachable", () => {
    const contentScript = readRepoFile("extension/content.js");
    const indicatorCss = contentScript.match(/\.classpilot-monitoring-indicator\s*\{[\s\S]*?\}/)?.[0] || "";
    expect(indicatorCss).not.toContain("pointer-events: none");
  });

  it("documents the real heartbeat retention default and hosted privacy URL", () => {
    const compliance = readRepoFile("COPPA_FERPA_Compliance.md");
    const extensionCompliance = readRepoFile("extension/COMPLIANCE.md");
    expect(compliance).not.toContain("default 24 hours");
    expect(compliance).not.toContain("default: 24 hours");
    expect(compliance).toContain("default 30 days");
    expect(extensionCompliance).toContain("https://school-pilot.net/privacy");
  });
});
