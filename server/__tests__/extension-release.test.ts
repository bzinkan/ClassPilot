import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

function readRepoFile(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8").replace(/\r\n?/g, "\n");
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
    expect(manifest.version).toBe("2.7.7");
    expect(manifest.storage?.managed_schema).toBe("managed_schema.json");
  });

  it("installs the fail-closed gate at document_start and keeps classroom UI idle", () => {
    const manifest = JSON.parse(readRepoFile("extension/manifest.json"));
    expect(manifest.content_scripts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        js: ["auth-gate-bootstrap.js"],
        run_at: "document_start",
      }),
      expect.objectContaining({
        js: ["content.js"],
        run_at: "document_idle",
      }),
    ]));
  });

  it("ships the fast-gate kill switch enabled by default", () => {
    const schema = JSON.parse(readRepoFile("extension/managed_schema.json"));
    expect(schema.properties?.fastAuthGateEnabled).toMatchObject({ type: "boolean", default: true });
  });

  it("keeps live auth readiness separate from cached presentation", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const frameScript = readRepoFile("extension/auth-gate-frame.js");
    expect(serviceWorker).toContain("sharedSignInConfigCacheV1");
    for (const phase of ["authenticated", "loading", "ready", "setup_required", "unavailable"]) {
      expect(serviceWorker).toContain(`'${phase}'`);
    }
    expect(frameScript).toContain("classpilot-auth-retry");
    expect(serviceWorker).toContain("configFetchedAt");
    expect(serviceWorker).toContain("retryAt");
  });

  it("isolates credential controls inside the closed extension auth frame", () => {
    const manifest = JSON.parse(readRepoFile("extension/manifest.json"));
    const contentScript = readRepoFile("extension/content.js");
    const frameScript = readRepoFile("extension/auth-gate-frame.js");
    const frameResources = manifest.web_accessible_resources?.find((entry: { resources?: string[] }) => (
      entry.resources?.includes("auth-gate-frame.html")
    ));

    expect(contentScript).toContain("attachShadow({ mode: 'closed' })");
    expect(contentScript).not.toContain("frame.name = 'classpilot-auth-gate-frame'");
    expect(contentScript).toContain("secureAuthGateFrameUrl(authGateSecureFrameNonce)");
    expect(contentScript).toContain("crypto.getRandomValues(bytes)");
    expect(contentScript).toContain("event.source !== authGateSecureFrame?.contentWindow");
    expect(contentScript).toContain("event.origin !== AUTH_GATE_FRAME_ORIGIN");
    expect(contentScript).toContain("event.data?.nonce !== authGateSecureFrameNonce");
    expect(contentScript).toContain("!event.isTrusted");
    expect(contentScript).toContain("pointer-events: none");
    expect(contentScript).toContain("pointer-events: auto");
    expect(contentScript).toContain("gate.replaceWith(replacement)");
    expect(frameResources).toMatchObject({
      resources: expect.arrayContaining([
        "auth-gate-frame.html",
        "auth-gate-frame.css",
        "auth-gate-frame.js",
      ]),
      matches: ["http://*/*", "https://*/*"],
      use_dynamic_url: true,
    });
    for (const credentialId of [
      "classpilot-auth-email",
      "classpilot-auth-student-id",
      "classpilot-auth-pin",
    ]) {
      expect(frameScript).toContain(credentialId);
    }
    expect(frameScript).toContain("CLASSPILOT_AUTH_FRAME_INIT");
    expect(frameScript).toContain("CLASSPILOT_AUTH_FRAME_READY");
    expect(frameScript).toContain("CLASSPILOT_AUTH_FRAME_LEAVING");
    expect(frameScript).toContain("chrome.runtime.onMessage.addListener");
  });

  it("keeps the auth surface authoritative across hostile DOM and top-layer replacement", () => {
    const bootstrap = readRepoFile("extension/auth-gate-bootstrap.js");
    const contentScript = readRepoFile("extension/content.js");
    expect(bootstrap).toContain("integrityObserver.observe(document");
    expect(contentScript).toContain("authGateConnectionObserver.observe(document");
    for (const source of [bootstrap, contentScript]) {
      expect(source).toContain("element instanceof Element");
      expect(source).toContain("element.setAttribute('inert', '')");
      expect(source).toContain("setProperty('pointer-events', 'none', 'important')");
      expect(source).toContain("setProperty('display', 'none', 'important')");
      expect(source).toContain("original.displayPriority");
      expect(source).toContain("dialog.close()");
      expect(source).toContain("document.exitFullscreen");
      expect(source).toContain("classpilotAuthRecovery = 'restored'");
      expect(source).toContain("documentRoot.appendChild(");
    }
  });

  it("structurally detaches page-owned browsing contexts until the gate releases", () => {
    const bootstrap = readRepoFile("extension/auth-gate-bootstrap.js");
    const contentScript = readRepoFile("extension/content.js");

    expect(bootstrap).toContain("const detachedBrowsingContexts = new Map()");
    expect(contentScript).toContain("const authGateDetachedBrowsingContexts = new Map()");
    for (const source of [bootstrap, contentScript]) {
      expect(source).toContain("document.querySelectorAll('iframe, frame, object, embed')");
      expect(source).toContain("parent: contextElement.parentNode");
      expect(source).toContain("nextSibling: contextElement.nextSibling");
      expect(source).toContain("contextElement.remove()");
      expect(source).toContain("placement.parent.insertBefore(contextElement, anchor)");
    }
    expect(bootstrap).toMatch(
      /restoreDetachedBrowsingContexts\(\)[\s\S]*restoreQuarantinedElement\(element\)/,
    );
    expect(contentScript).toMatch(
      /restoreAuthGateDetachedBrowsingContexts\(\)[\s\S]*restoreAuthGateQuarantinedElement\(element\)/,
    );
  });

  it("fences every managed auth authority alias behind a correlated direct reread", () => {
    const bootstrap = readRepoFile("extension/auth-gate-bootstrap.js");
    const contentScript = readRepoFile("extension/content.js");
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const authorityKeys = [
      "fastAuthGateEnabled",
      "serverUrl",
      "classpilotServerUrl",
      "schoolId",
      "classpilotSchoolId",
      "schoolSlug",
      "classpilotSchoolSlug",
      "enrollmentKey",
      "classpilotEnrollmentKey",
    ];

    for (const source of [bootstrap, contentScript]) {
      for (const key of authorityKeys) expect(source).toContain(`'${key}'`);
      expect(source).toContain("revalidateManagedPolicy: true");
      expect(source).toContain("response?.managedPolicyFence === fence");
      expect(source).toContain("Number.isSafeInteger(workerGeneration)");
      expect(source).toMatch(/responseRevision !== null && responseRevision >=/);
      expect(source).toContain("managedPolicyFenceValidated: true");
    }
    expect(bootstrap).toContain("requestGeneration !== stateRequestGeneration");
    expect(contentScript).toContain("requestGeneration !== authGateStateRequestGeneration");
    expect(contentScript).toContain("authGateStateRequestGeneration += 1");
    expect(contentScript).toContain("__classpilotAuthGateBootstrap.release({ fromContent: true })");
    expect(bootstrap).toContain("gateOwnedByContent && options.fromContent !== true");
    expect(serviceWorker).toContain("async function revalidateManagedAuthGatePolicy(managedPolicyFence)");
    expect(serviceWorker).toContain("managedPolicyFence,");
    expect(serviceWorker).toContain("managedPolicyGeneration: policyGeneration");
    expect(serviceWorker).toContain("These proof fields exist only on this correlated direct reply");
  });

  it("durably fences login enforcement and reserves restart-safe revisions", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toContain("const STUDENT_AUTH_COMMIT_PENDING_KEY = 'studentAuthCommitPendingV1'");
    expect(serviceWorker).toContain("const AUTH_GATE_REVISION_STORAGE_KEY = 'authGateRevisionV1'");
    expect(serviceWorker).toContain("const AUTH_GATE_REVISION_BLOCK_SIZE = 1000000");
    expect(serviceWorker).toMatch(
      /manualStudentLoginNow[\s\S]*beginStudentAuthCommit[\s\S]*setManualAuthState[\s\S]*applyClassroomStateFromAuthResponse[\s\S]*completeStudentAuthCommit[\s\S]*notifyAuthGateStateToTabs/,
    );
    expect(serviceWorker).toMatch(
      /function hasStudentAuth\(\)[\s\S]*!studentAuthInvalidating[\s\S]*!studentAuthCommitPending/,
    );
    expect(serviceWorker).toContain("const rawLocalKv = strictStorageArea(chrome.storage.local, 'local storage')");
    expect(serviceWorker).toContain("const durableLocalKv = routedStudentStorageArea(rawLocalKv, rawSessionKv)");
    expect(serviceWorker).toContain("const durableSessionKv = rawSessionKv");
    expect(serviceWorker).toContain("await durableLocalKv.set({ [AUTH_GATE_REVISION_STORAGE_KEY]: nextCeiling })");
    expect(serviceWorker).toMatch(
      /durableLocalKv\.get\(\[AUTH_GATE_REVISION_STORAGE_KEY\]\)[\s\S]*reserveAuthGateRevisionBlock\(stored\[AUTH_GATE_REVISION_STORAGE_KEY\]\)/,
    );
    expect(serviceWorker).toContain("const authGateRevisionReadyPromise = new Promise");
    expect(serviceWorker).toContain("async function awaitAuthGateRevisionPublicationReady()");
    expect(serviceWorker).toContain("async function getPublishableAuthGateState()");
    expect(serviceWorker).toMatch(
      /getPublishableAuthGateState\(\)[\s\S]*await awaitAuthGateRevisionPublicationReady\(\)/,
    );
    expect(serviceWorker).toContain("let authCommitRecoveryPromise = Promise.resolve()");
  });

  it("invalidates old auth before persisting a directly revalidated authority", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const start = serviceWorker.indexOf("async function runManagedAuthGatePolicyRevalidation");
    const end = serviceWorker.indexOf("function restoreSharedSignInPresentationCache", start);
    const revalidation = serviceWorker.slice(start, end);
    const clearIndex = revalidation.indexOf("await clearStudentAuth('managed_policy_direct_revalidation'");
    const applyIndex = revalidation.indexOf("applyAuthoritativeManagedAuthGateSnapshot(");
    const persistIndex = revalidation.indexOf("await durableLocalKv.set({", applyIndex);

    expect(clearIndex).toBeGreaterThan(-1);
    expect(applyIndex).toBeGreaterThan(clearIndex);
    expect(persistIndex).toBeGreaterThan(applyIndex);
    expect(serviceWorker).toContain(
      "const invalidationPersisted = durableLocalKv.set({ [STUDENT_AUTH_INVALIDATING_KEY]: true })",
    );
    expect(serviceWorker).toMatch(
      /async function clearStudentAuthNow\([^)]*invalidationPersisted\)[\s\S]*await invalidationPersisted/,
    );
  });

  it("coalesces concurrent managed-policy proofs while echoing each caller fence", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toContain("let managedAuthGateDirectRevalidationInFlight = null");
    expect(serviceWorker).toContain("async function runManagedAuthGatePolicyRevalidation()");
    expect(serviceWorker).toMatch(
      /if \(!managedAuthGateDirectRevalidationInFlight\)[\s\S]*runManagedAuthGatePolicyRevalidation\(\)[\s\S]*managedAuthGateDirectRevalidationInFlight = trackedRun/,
    );
    expect(serviceWorker).toContain("const result = await managedAuthGateDirectRevalidationInFlight");
    expect(serviceWorker).toMatch(
      /return \{[\s\S]*\.\.\.result,[\s\S]*managedPolicyFence,[\s\S]*\};/,
    );
  });

  it("commit-fences both Chrome-profile registration adoption paths", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const ensureStart = serviceWorker.indexOf("async function ensureRegisteredNow()");
    const ensureEnd = serviceWorker.indexOf("// Run auto-registration on install and startup", ensureStart);
    const ensureRegistration = serviceWorker.slice(ensureStart, ensureEnd);
    const directStart = serviceWorker.indexOf("async function registerDeviceWithStudentNow(");
    const directEnd = serviceWorker.indexOf("// Send heartbeat with current tab info", directStart);
    const directRegistration = serviceWorker.slice(directStart, directEnd);

    for (const registration of [ensureRegistration, directRegistration]) {
      const beginIndex = registration.indexOf("await beginStudentAuthCommit(");
      const persistStartIndex = registration.indexOf(
        "const durableStatePersisted = durableLocalKv.set({",
        beginIndex,
      );
      const sessionPersistIndex = registration.indexOf(
        "await setManualAuthState({",
        persistStartIndex,
      );
      const persistCompleteIndex = registration.indexOf(
        "await Promise.all([markerCleared, durableStatePersisted]);",
        sessionPersistIndex,
      );
      const applyIndex = registration.indexOf(
        "await applyClassroomStateFromAuthResponse(",
        persistCompleteIndex,
      );
      const requireIndex = registration.indexOf("requireApplied: true", applyIndex);
      const contextIndex = registration.indexOf(
        "authContext: committedAuthContext",
        requireIndex,
      );
      const completeIndex = registration.indexOf("await completeStudentAuthCommit(", contextIndex);
      expect(beginIndex).toBeGreaterThan(-1);
      expect(persistStartIndex).toBeGreaterThan(beginIndex);
      expect(sessionPersistIndex).toBeGreaterThan(persistStartIndex);
      expect(persistCompleteIndex).toBeGreaterThan(sessionPersistIndex);
      expect(applyIndex).toBeGreaterThan(persistCompleteIndex);
      expect(requireIndex).toBeGreaterThan(applyIndex);
      expect(contextIndex).toBeGreaterThan(requireIndex);
      expect(completeIndex).toBeGreaterThan(contextIndex);
    }
    expect(ensureRegistration).toContain("student_registration_commit_failed");
    expect(directRegistration).toContain("student_auto_registration_commit_failed");
  });

  it("clears auth before persisting a managed storage-change authority", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const start = serviceWorker.indexOf("function handleManagedAuthGateStorageChange");
    const end = serviceWorker.indexOf("if (chrome.storage?.onChanged)", start);
    const transition = serviceWorker.slice(start, end);
    const clearIndex = transition.indexOf(
      "authorityAuthClearPromise = clearStudentAuth('managed_auth_authority_changed'",
    );
    const awaitClearIndex = transition.indexOf("authorityAuthClearPromise,", clearIndex);
    const applyIndex = transition.indexOf(
      "applyAuthoritativeManagedAuthGateSnapshot(",
      awaitClearIndex,
    );
    const persistIndex = transition.indexOf(
      "await durableLocalKv.set(policyPersistence)",
      applyIndex,
    );

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(clearIndex).toBeGreaterThan(-1);
    expect(awaitClearIndex).toBeGreaterThan(clearIndex);
    expect(applyIndex).toBeGreaterThan(awaitClearIndex);
    expect(persistIndex).toBeGreaterThan(applyIndex);
    expect(transition).toContain("{ persist: false }");
    expect(serviceWorker).toContain("handleManagedAuthGateStorageChange(changes, areaName);");
  });

  it("drops a pre-2.6.6 custom server when authoritative managed policy omits it", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toMatch(
      /applyAuthoritativeManagedAuthGateSnapshot[\s\S]*!descriptor\.serverManaged \|\| !descriptor\.serverValid[\s\S]*CONFIG\.serverUrl = DEFAULT_SERVER_URL/,
    );
    expect(serviceWorker).toContain("const authoritativeServerOrigin = descriptor.serverManaged");
    expect(serviceWorker).toContain(": normalizedServerOrigin(DEFAULT_SERVER_URL)");
    expect(serviceWorker).toContain("resetSharedSignInLoginConfigCache({ clearPersisted: true })");
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

  it("launches the PassPilot kiosk from the auth gate and never paints the gate over it", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const contentScript = readRepoFile("extension/content.js");
    expect(serviceWorker).toContain("function kioskLaunchUrl");
    expect(serviceWorker).toContain("launch=gate");
    expect(serviceWorker).toContain("if (isKioskGateUrl(tab.url || '')) {");
    expect(contentScript).toContain("state.kioskOrigin");
    expect(contentScript).toContain("classpilot-auth-kiosk-launch");
    expect(contentScript).toContain("window.location.pathname.startsWith('/passpilot/kiosk/')");
  });

  it("uses a one-use managed-device launch ticket without a stable kiosk URL identifier", () => {
    const manifest = JSON.parse(readRepoFile("extension/manifest.json"));
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(manifest.permissions).toContain("enterprise.deviceAttributes");
    expect(serviceWorker).toContain("getDirectoryDeviceId");
    expect(serviceWorker).toContain("function requestKioskLaunchUrl");
    expect(serviceWorker).toContain("/api/classpilot/kiosk/launch-ticket/preflight");
    expect(serviceWorker).toContain("/api/classpilot/kiosk/launch-ticket");
    expect(serviceWorker).toContain("launchUrl.hash = `launchTicket=${encodeURIComponent(ticket)}`");
    expect(serviceWorker).toContain("'kioskLaunchTicketV2'");
    expect(serviceWorker).toContain("const KIOSK_LAUNCH_TICKET_V2_MAX_EXPIRY_MS = 660 * 1000");
    expect(serviceWorker).not.toContain("&device=");
    expect(serviceWorker).not.toContain("classpilot-kiosk-device:");
  });

  it("suppresses the student FAB on kiosk pages while keeping the monitoring disclosure", () => {
    const contentScript = readRepoFile("extension/content.js");
    expect(contentScript).toContain("function reconcileKioskFabSuppression");
    expect(contentScript).toContain("function isPassPilotKioskPage");
    expect(contentScript).toContain("const kioskSuppressed = isPassPilotKioskPage();");
    // The kiosk-suppressed branch must still render the disclosure indicator.
    const suppressedBranch = contentScript.slice(
      contentScript.indexOf("if (kioskSuppressed) {"),
      contentScript.indexOf("fabContainer.innerHTML = `", contentScript.indexOf("if (kioskSuppressed) {") + 30) + 600
    );
    expect(suppressedBranch).toContain("classpilot-monitoring-indicator");
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
    expect(runtimeBody).toMatch(
      /await reconcileClassroomStateTabsBestEffort\(state,\s*\{\s*authContext,\s*assertCurrent,\s*runtimeOwner,/,
    );
    expect(runtimeBody).toContain("DNR is the durable enforcement boundary");
    expect(serviceWorker).toContain("CLASSROOM_STATE_RECONCILE_ALARM");
    expect(serviceWorker).toContain("Existing-tab reconciliation deferred");
    expect(serviceWorker).toContain("if (globalBlockedDomainsStateTrusted) ranges.push('school')");
    expect(serviceWorker).toContain("hasOwnProperty.call(stored, 'globalBlockedDomains')");
    expect(runtimeCore).toContain("function planClassroomTabReconciliation");
    expect(runtimeCore).toContain("isProtectedInternalTab");
  });

  it("composes tab limits with domain-preserving foreground reconciliation", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const runtimeCore = readRepoFile("extension/classroom-runtime-core.js");
    expect(runtimeCore).toContain("function planTabLimitRemovals");
    expect(runtimeCore).toContain("additionalTabCount: plan.createUrl ? 1 : 0");
    expect(serviceWorker).toContain("maxTabs: currentMaxTabs");
    expect(serviceWorker).toContain("RuntimeCore.planTabLimitRemovals");
    expect(serviceWorker).toContain("if (!policySource && policy.currentMaxTabs)");
    expect(serviceWorker).toContain("preserveTabId: existingCompliant?.id ?? policyTab.id");
    expect(serviceWorker).toContain("else if (removalIds.length > 0)");
    expect(serviceWorker).toContain("reconcileExcessTabs = true");
    expect(serviceWorker).toContain("authContext: eventAuthContext");
    expect(serviceWorker).toContain("const limits = [teacherMaxTabs, schoolMaxTabs]");
    expect(serviceWorker).toContain("return limits.length ? Math.min(...limits) : null");
  });

  it("focuses and verifies the selected window with one fallback creation path", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const reconcileStart = serviceWorker.indexOf("async function reconcileExistingTabsForClassroomState");
    const reconcileEnd = serviceWorker.indexOf("async function resolveCurrentUrlMarker", reconcileStart);
    const reconcileBody = serviceWorker.slice(reconcileStart, reconcileEnd);
    expect(reconcileBody).toContain("{ active: true, lastFocusedWindow: true }");
    expect(reconcileBody).toContain("await focusWindow(targetTab.windowId)");
    expect(reconcileBody).toContain("Classroom target did not become the foreground tab");
    expect(reconcileBody).toContain("Classroom fallback did not become the foreground tab");
    expect(reconcileBody.match(/await createTab\(/g)).toHaveLength(1);
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
    expect(serviceWorker).toContain(
      "await applyClassroomState(snapshot, { reason, authContext, authorityEnvelope: data })",
    );
    expect(serviceWorker).toContain("emitEvent: false");
    expect(serviceWorker).toContain("CLASSROOM_STATE_STUDENT_BINDING_KEY");
    expect(serviceWorker).toMatch(
      /applyClassroomStateFromAuthResponse\(data, 'student_login', \{\s*requireApplied: true,\s*authContext: committedAuthContext,\s*authMutationHeld: true,?\s*\}\)/,
    );
    expect(
      serviceWorker.match(
        /applyClassroomStateFromAuthResponse\(\s*data,\s*'student_registration',\s*\{\s*requireApplied: true,\s*authContext: committedAuthContext,\s*authMutationHeld: true,?\s*\},?\s*\)/g,
      ),
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
    expect(serviceWorker).toMatch(
      /await kv\.set\(\{\s*\[MONITORING_STATE_STORAGE_KEY\]: persistedMonitoringState,/,
    );
    expect(serviceWorker).toMatch(
      /trackingState === nextState\s*&& persistedMonitoringState\.state === nextState\s*&& persistedMonitoringStateScope === expectedScope/,
    );
    expect(serviceWorker).toContain("await flushMonitoringEventOutbox()");
    expect(serviceWorker).toContain("reason: 'scope_initialized'");
    const disableStart = serviceWorker.indexOf("async function disableForInactiveLicense");
    const disableEnd = serviceWorker.indexOf("async function checkLicenseStatus", disableStart);
    const disableBody = serviceWorker.slice(disableStart, disableEnd);
    expect(disableBody.indexOf("transitionTrackingState(TRACKING_STATES.OFF"))
      .toBeLessThan(disableBody.indexOf("disconnectWebSocket({ authContext })"));
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
    expect(serviceWorker).toContain("lastSuccessfulHeartbeatAt: Number(connectivityHealth.lastSuccessAt || 0)");
    expect(serviceWorker).toContain("screenshotPolicySource,");
    expect(serviceWorker).toContain("screenshotPolicyAdoptedAt,");
    expect(serviceWorker).toContain("lastCaptureAttemptAt: lastScreenshotAttemptAt");
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
    expect(serviceWorker).toMatch(
      /handleHeartbeatPendingMessages\(\s*data\.pendingMessages,\s*heartbeatMessageBinding,\s*heartbeatAuthContext,?\s*\)/,
    );
    expect(serviceWorker).toContain("assertCurrentCommandAuthority({\n        type: 'teacher-message'");
    expect(serviceWorker).toContain("sendCommandAck(commandId, 'completed'");
    const sendHeartbeatStart = serviceWorker.indexOf("async function sendHeartbeat(");
    const responseBindingGuard = serviceWorker.indexOf(
      "heartbeatMessageBinding !== currentHeartbeatBinding",
      sendHeartbeatStart
    );
    const heartbeatSuccess = serviceWorker.indexOf(
      "await recordHeartbeatSuccess(Date.now(), heartbeatAuthContext)",
      sendHeartbeatStart,
    );
    const classroomResponseApply = serviceWorker.indexOf(
      "await applyClassroomStateFromAuthResponse(data, 'heartbeat_reconcile')",
      sendHeartbeatStart
    );
    expect(responseBindingGuard).toBeGreaterThan(sendHeartbeatStart);
    expect(responseBindingGuard).toBeLessThan(heartbeatSuccess);
    expect(responseBindingGuard).toBeLessThan(classroomResponseApply);
    expect(serviceWorker).toContain("scheduleEventHeartbeat('identity-changed-reconcile')");
    expect(serviceWorker).toContain("await clearStudentMessageState(reason)");
    expect(serviceWorker).toContain("await reconcileMessageInboxIdentity('worker-wake')");
    expect(runtimeCore).toContain("const MAX_MESSAGE_INBOX_ENTRIES = 50;");
    expect(runtimeCore).toContain("const MAX_MESSAGE_DEDUP_IDS = 500;");
    expect(popup).toContain("type: 'get-message-inbox'");
    expect(popup).not.toContain("chrome.storage.local.get(['messages'])");
  });

  it("advertises protocol 3 capabilities on auth and heartbeat", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    for (const capability of [
      "classroomStateV1",
      "fabStateRevisionV1",
      "exactTabCloseV1",
      "scopedAuthorityChecksV1",
      "authBoundTelemetryV1",
      "exactBindingAckV2",
      "exactTabCloseV2",
      "studentChatIdempotencyV1",
      "screenshotTrackingWindowLeaseV1",
      "screenshotObservationLeaseV1",
      "safetyEvidenceCaptureV1",
      "liveViewIceServersV1",
      "kioskLaunchTicketV1",
      "kioskLaunchTicketV2",
      "screenOnlyUnlockV1",
      "durableChatAckV1",
      "commandAckReceiptV1",
      "classroomOverlayRestoreV1",
      "liveViewNegotiationV1",
      "domainPreservingRestrictionsV1",
    ]) {
      expect(serviceWorker).toContain(`'${capability}'`);
    }
    expect(serviceWorker).toContain("clientProtocolVersion: CLIENT_PROTOCOL_VERSION");
    expect(serviceWorker).toContain("const CLIENT_PROTOCOL_VERSION = 3");
    expect(serviceWorker).toContain("...extensionProtocolDescriptor()");
    expect(serviceWorker).toContain("message.type === 'fab-state-sync'");
  });

  it("fences authenticated work to one immutable context and treats replacement as cancellation", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toContain("authContextId: null");
    expect(serviceWorker).toContain("function generateAuthContextId()");
    expect(serviceWorker).toContain("function captureAuthenticatedContext(");
    expect(serviceWorker).toContain("function assertAuthenticatedContextCurrent(");
    expect(serviceWorker).toContain("error.code = 'AUTH_CONTEXT_SUPERSEDED'");
    expect(serviceWorker).toContain("authContextAbortController.abort()");
    expect(serviceWorker).toContain("signal: authContextAbortController.signal");
    expect(serviceWorker).toContain("signal: heartbeatRequestController.signal");
    expect(serviceWorker).toContain("const HEARTBEAT_REQUEST_TIMEOUT_MS = 15 * 1000");
    expect(serviceWorker).toContain("heartbeatAuthContext.signal.addEventListener('abort', abortHeartbeatForAuth");
    expect(serviceWorker).toContain("signal: captureRequestAbortController.signal");
    expect(serviceWorker).toContain("capturePolicySignal.addEventListener('abort', abortCaptureRequest");
    expect(serviceWorker).toContain("assertAuthenticatedContextCurrent(screenshotAuthContext, `screenshot:${reason}:captured-pixels`)");
    expect(serviceWorker).toContain("assertAuthenticatedContextCurrent(heartbeatAuthContext, `heartbeat:${reason}:response-body`)");
  });

  it("keeps student chat durable, bounded, idempotent, and exact-bound", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const contentScript = readRepoFile("extension/content.js");
    const popup = readRepoFile("extension/popup.js");
    expect(serviceWorker).toContain("const STUDENT_CHAT_OUTBOX_KEY = 'studentChatOutboxV1'");
    expect(serviceWorker).toContain("const STUDENT_CHAT_MAX_ENTRIES = 40");
    expect(serviceWorker).toContain("const STUDENT_CHAT_MAX_BYTES = 128 * 1024");
    expect(serviceWorker).toContain("const STUDENT_CHAT_MAX_AGE_MS = 30 * 60 * 1000");
    expect(serviceWorker).toContain("String(data.clientMessageId || '') === attempted.clientMessageId");
    expect(serviceWorker).toContain("String(data.messageId || '').trim()");
    expect(serviceWorker).toContain("await removeDeliveredStudentChatEntry(attempted.clientMessageId, authContext)");
    expect(serviceWorker).toContain("await discardStudentChatOutbox().catch(() => {})");
    for (const source of [contentScript, popup]) {
      expect(source).toContain("globalThis.crypto?.randomUUID?.()");
      expect(source).toContain("clientMessageId,");
    }
    for (const status of ["Sending", "Retrying", "Delivered", "Failed"]) {
      expect(serviceWorker).toContain(`'${status}'`);
    }
  });

  it("fails ambient screenshots private and captures exact safety evidence before close", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toContain("function adoptScreenshotPolicy(rawPolicy, context, options = {})");
    expect(serviceWorker).toContain("hasNegotiatedCapability('screenshotTrackingWindowLeaseV1', context)");
    expect(serviceWorker).toContain("hasNegotiatedCapability('screenshotObservationLeaseV1', context)");
    expect(serviceWorker).toContain("status: 'paused_unobserved'");
    expect(serviceWorker).toContain("const maximumLeaseSeconds = leaseKind === 'tracking_window' ? 90 : 120");
    expect(serviceWorker).toContain("function requestImmediateScreenshotCapture()");
    expect(serviceWorker).toContain("screenshotPolicyGeneration !== expectedGeneration");
    expect(serviceWorker).toContain("screenshotPolicyState.authorityScope || null");
    expect(serviceWorker).toContain("screenshotAuthority: captureScreenshotAuthority");
    expect(serviceWorker).toContain("capturedAt,");
    expect(serviceWorker).toContain("serverTime + boundedLeaseMs - responseReceivedAt");
    expect(serviceWorker).toMatch(
      /wsAuthenticatedResponseGuard = \{[\s\S]*protocolPolicyGeneration:[\s\S]*screenshotPolicyGeneration:[\s\S]*requestStartedAt:/,
    );
    expect(serviceWorker).toContain(
      "screenshotRequestGeneration: authenticatedResponseGuard.screenshotPolicyGeneration",
    );
    expect(serviceWorker).toContain("responseBody?.code === 'SCREENSHOT_PAUSED_UNOBSERVED'");
    expect(serviceWorker).toContain("function applyServerScreenshotPolicyDenial(");
    expect(serviceWorker).toContain("response.status === 402");
    expect(serviceWorker).toContain("isClassPilotNotEntitledResponse(responseBody)");
    expect(serviceWorker).toContain("await invalidateStudentTokenFromHeartbeat(");
    expect(serviceWorker).toContain("response.status === 404");
    expect(serviceWorker).toContain("screenshotPolicyAppliedGeneration = denialGeneration");
    expect(serviceWorker).toContain("function subscribeTabNavigationFence(");
    expect(serviceWorker).toContain("? '/api/classpilot/device/screenshot'");
    expect(serviceWorker).toContain(": '/api/device/screenshot'");
    expect(serviceWorker).toContain("async function captureSafetyEvidence(");
    expect(serviceWorker).toContain("expiresAt > Date.now() + 35 * 1000");
    expect(serviceWorker).toContain("captureKind: 'safety_evidence'");
    expect(serviceWorker).toContain("evidenceRequestId: requestId");
    expect(serviceWorker).toContain("tabSnapshotRevision: snapshotRevision");
    expect(serviceWorker).toContain("...extensionProtocolDescriptor()");
    const closeStart = serviceWorker.indexOf("case 'close-tabs':");
    const safetyIndex = serviceWorker.indexOf("result.safetyEvidence = await captureSafetyEvidence(", closeStart);
    const closeIndex = serviceWorker.indexOf("await closeExactTabTargets(exact, authContext)", safetyIndex);
    expect(safetyIndex).toBeGreaterThan(closeStart);
    expect(closeIndex).toBeGreaterThan(safetyIndex);
  });

  it("retrieves short-lived Live View ICE configuration by authenticated POST", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const start = serviceWorker.indexOf("async function fetchLiveViewIceConfiguration");
    const end = serviceWorker.indexOf("function liveViewContextFor", start);
    const fetchIce = serviceWorker.slice(start, end);
    expect(fetchIce).toContain("hasNegotiatedCapability('liveViewIceServersV1', authContext)");
    expect(fetchIce).toContain("/api/classpilot/device/live-view/ice-servers`");
    expect(fetchIce).toContain("method: 'POST'");
    expect(fetchIce).toContain("body: JSON.stringify({ negotiationId })");
    expect(fetchIce).toContain("signal: authContext.signal");
    expect(fetchIce).not.toContain("?negotiationId=");
  });

  it("keeps logs and Sentry surfaces free of raw identities and command payloads", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const offscreen = readRepoFile("extension/offscreen.js");
    expect(serviceWorker).toContain("function safeDiagnosticError(error)");
    expect(serviceWorker).toContain("delete event.user");
    expect(serviceWorker).toContain("delete event.contexts");
    expect(serviceWorker).toContain("delete event.extra");
    expect(serviceWorker).toContain("delete event.tags");
    const consoleStatements = serviceWorker
      .split("\n")
      .filter((line) => line.includes("console."))
      .join("\n");
    for (const forbidden of [
      "studentEmail: CONFIG.studentEmail",
      "deviceId: CONFIG.deviceId",
      "Flight Path applied with allowed domains:",
      "Chat notification sent:', chatFromName, chatMessage",
      "Check-in request received:', request",
      "Update received from server:', receivedGlobalBlockedDomains",
      "duplicate remote-control _msgId', msgId",
    ]) {
      expect(consoleStatements).not.toContain(forbidden);
    }
    expect(offscreen).not.toContain("console.error('[Offscreen] Unexpected signaling error:', error");
  });

  it("uses worker-safe heartbeat/screenshot scheduling and generation-bound offscreen RPC", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const offscreen = readRepoFile("extension/offscreen.js");
    expect(serviceWorker).toContain("chrome.alarms.create('heartbeat'");
    expect(serviceWorker).toContain("if (heartbeatInFlight)");
    expect(serviceWorker).not.toContain("heartbeatPendingReason");
    expect(serviceWorker).toContain("const EVENT_HEARTBEAT_COALESCE_MS = 2000");
    expect(serviceWorker).toContain("typeof chrome.runtime.getContexts === 'function'");
    expect(serviceWorker).toContain("creatingOffscreen = null;");
    expect(serviceWorker).toContain("type: 'WS_STATUS'");
    expect(serviceWorker).toContain("wsAuthenticatedGeneration !== wsConnectionGeneration");
    expect(serviceWorker).toContain("SCREENSHOT_COMMAND_MIN_GAP_MS");
    expect(serviceWorker).not.toContain("} else if (screenshotScheduled) {\n        // Capture immediately on first heartbeat");
    expect(offscreen).toContain("proxyConnectionGeneration");
    expect(offscreen).toContain("authenticated: proxyAuthenticated");
    expect(offscreen).toContain("Number(requestedGeneration) === proxyConnectionGeneration");
    expect(offscreen).toContain("Every capture attempt is a new negotiation");
    expect(offscreen).toContain("track.onended = () =>");
    expect(offscreen).toContain("peerConnection.onconnectionstatechange = null");
    expect(offscreen).toMatch(/proxyWs\.onclose = \(\) => \{[\s\S]*stopScreenShare\(\)/);
    expect(offscreen).toMatch(/payload\?\.type === 'auth-error'[\s\S]*stopScreenShare\(\)/);
    expect(serviceWorker).toContain("function revokeRetiredOffscreenAuthority(");
    expect(serviceWorker).toMatch(/function abortActiveAuthContext\(\)[\s\S]*revokeRetiredOffscreenAuthority\(retiredLiveViewContext, retiredTransportIdentity\)/);
    expect(offscreen).toMatch(/if \(activeLiveViewContext\) stopScreenShare\(\);[\s\S]*Close any existing connection/);
    expect(serviceWorker).toContain("if (message.type === 'CONNECTION_FAILED')");
    expect(serviceWorker).toContain("await stopScreenShare();");
    expect(serviceWorker).toContain("reason: 'student-websocket-closed'");
    expect(serviceWorker).toContain("reason: 'student-websocket-auth-rejected'");
    expect(serviceWorker).toContain("activeLiveViewNegotiationId = negotiationId");
    expect(serviceWorker).toContain("activeLiveViewTeachingSessionId = teachingSessionId");
    expect(serviceWorker).toMatch(/handleScreenShareRequest\([\s\S]*message\.setupExpiresAt,[\s\S]*message\.expiresAt/);
    expect(serviceWorker).toContain("reason: 'classroom-authority-changed'");
    expect(serviceWorker).toContain("type: 'stop-share'");
    expect(serviceWorker).toContain("negotiationId: message.negotiationId");
    expect(offscreen).toContain("signal.negotiationId !== activeNegotiationId");
    expect(offscreen).toContain("scheduleLiveViewExpiry(");
    expect(offscreen).toContain("function resolveLiveViewExpirySchedule(");
    expect(offscreen).toContain("latestLiveViewIdentity = Object.freeze({ ...identity })");
    expect(offscreen).toContain("return { success: false, status: 'stale-negotiation'");
    expect(serviceWorker).toContain("function reserveLiveViewNegotiation(");
    expect(offscreen).toContain("iceConfigurationExpiresAt,");
    expect(offscreen).toContain("attemptLiveViewIceRestart");
    expect(offscreen).toContain("expireLiveView('setup-expired', negotiationId)");
    expect(offscreen).toContain("expireLiveView('maximum-duration', negotiationId)");
    expect(serviceWorker).toContain("message.type === 'LIVE_VIEW_EXPIRED'");
    expect(serviceWorker).toContain("activeStudentSessionId: null");
    expect(serviceWorker).toContain("assertCurrentStudentBinding(envelope, 'remote-control command', {");
    expect(serviceWorker).toContain("requireFullAuthority: requireExactTabAuthority");
    expect(serviceWorker).toContain("assertCurrentStudentBinding(message, 'durable teacher message')");
    expect(serviceWorker).toMatch(/function clearStudentAuth[\s\S]*studentAuthInvalidating = true;[\s\S]*disconnectWebSocket\(\)/);
    expect(serviceWorker).toMatch(/function adoptAuthenticatedStudentBinding[\s\S]*enqueueStudentAuthMutation/);
    expect(serviceWorker).toContain("assertAuthMutationCurrent(mutationGeneration, reason)");
    expect(serviceWorker).toContain("STUDENT_AUTH_INVALIDATING_KEY");
    expect(serviceWorker).toContain("enqueueStudentAuthMutation");
    expect(serviceWorker).toContain("runChromeProfileRegistration");
    expect(serviceWorker).toContain("chromeProfileRegistrationInFlight");
    expect(serviceWorker).toContain("manualStudentLoginPendingGeneration");
    expect(serviceWorker).toContain("refreshRegistrationAfterIdentityChange");
    expect(serviceWorker).toContain("persistedNonAuthConfig");
    expect(serviceWorker).toContain("function restoreWorkerWakeAuthState");
    expect(serviceWorker).toContain("let workerWakeRestoreGeneration = studentAuthMutationGeneration");
    expect(serviceWorker).toContain("workerWakeRestoreGeneration = studentAuthMutationGeneration");
    expect(serviceWorker).toMatch(/Promise\.all\(\[[\s\S]*restoreWorkerWakeAuthState\(/);
    expect(serviceWorker).not.toContain("// Load config from storage on startup");
    expect(serviceWorker).not.toMatch(/(?:chrome\.storage\.local|kv)\.set\(\{\s*config:\s*CONFIG/);
    expect(serviceWorker).toContain("if (authenticatedSchoolId) CONFIG.schoolId = authenticatedSchoolId");
    expect(serviceWorker).toMatch(/handleOffscreenMessage\(message\)[\s\S]*\.then\(sendResponse\)/);
    expect(serviceWorker).toMatch(/await handleWsEvent\([\s\S]*message\.authContextId,[\s\S]*message\.serverOrigin/);
    expect(serviceWorker).toContain("wsMessageProcessingTail");
  });

  it("persists identity-bound command acknowledgements until an exact receipt", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toContain("const COMMAND_ACK_OUTBOX_KEY = 'commandAckOutboxV1';");
    expect(serviceWorker).toContain("ackId: `${normalizedCommandId}:${ackState}`");
    expect(serviceWorker).toContain("await enqueueCommandAck(ack, authContext)");
    expect(serviceWorker).toContain("message.type === 'command-ack-receipt'");
    expect(serviceWorker).toContain("/api/classpilot/device/command-acks");
    expect(serviceWorker).toContain("slice(0, 50)");
    expect(serviceWorker).toContain("const CHAT_ACK_OUTBOX_KEY = 'chatAckOutboxV1';");
    expect(serviceWorker).toContain("message.type === 'chat-message-ack-receipt'");
    expect(serviceWorker).toContain("/api/classpilot/device/chat-acks");
    expect(serviceWorker).toContain("ackId: `chat:${messageId}:${deliveryStatus}`");
  });

  it("restores only binding/session-scoped FAB, timer, and poll state", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    const contentScript = readRepoFile("extension/content.js");
    expect(serviceWorker).toContain("const FAB_CONTEXT_STORAGE_KEY = 'fabContextV1';");
    expect(serviceWorker).toContain("const CLASSROOM_OVERLAY_STORAGE_KEY = 'classroomOverlayStateV1';");
    expect(serviceWorker).toContain("function resolveExactTabRefs");
    expect(serviceWorker).toContain("error.code = 'STALE_TAB_SNAPSHOT'");
    expect(serviceWorker).toContain("command.data.screenOnly === true");
    expect(serviceWorker).toContain(
      "await markPollResponsePersisted(pollId, option, actionRequest.authContext)",
    );
    expect(serviceWorker).toContain(
      "assertStudentActionRequestCurrent(actionRequest, 'poll response persistence')",
    );
    expect(contentScript).toContain("type: 'get-classroom-overlay-state'");
    expect(contentScript).toContain("Submitting response…");
    expect(contentScript).toContain("completePollResponse(pollId, selectedIndex)");
    expect(contentScript).toContain("const sessionSetChanged");
    expect(serviceWorker).toContain("const priorOwnershipRevision");
    expect(serviceWorker).toContain("nextOwnershipRevision < priorOwnershipRevision");
    expect(serviceWorker).toContain("function enqueueFabStateMutation");
  });

  it("rejects delayed commands outside the current immutable class authority", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toContain("const AUTHORITY_BOUND_COMMAND_TYPES");
    expect(serviceWorker).toContain("function assertCurrentCommandAuthority");
    expect(serviceWorker).toContain("COMMAND_AUTHORITY_MISSING");
    expect(serviceWorker).toContain("COMMAND_AUTHORITY_MISMATCH");
    expect(serviceWorker).toContain("assertCurrentCommandAuthority(command, envelope)");
    expect(serviceWorker).toContain("'messaging-toggle'");
    expect(serviceWorker).toContain("'hand-raising-toggle'");
    expect(serviceWorker).toContain("'hand-dismissed'");
    expect(serviceWorker).toContain("'teacher-message'");
    expect(serviceWorker).toContain("const activeSessionIds = activeTeachingSessionIds()");
    expect(serviceWorker).toContain("!activeSessionIds.includes(authority.teachingSessionId)");
    expect(serviceWorker).toContain("currentClassroomState?.supervisionContextId");
    expect(serviceWorker).toContain("currentClassroomState.teachingSessionId === sessionId");
    expect(serviceWorker).toContain("const messagingRevision = Number(command.data.revision)");
    expect(serviceWorker).toContain("const handRevision = Number(command.data.revision)");
  });

  it("recognizes canonical and legacy entitlement failures before clearing auth", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toContain("function isClassPilotNotEntitledResponse");
    expect(serviceWorker).toContain("CLASSPILOT_NOT_ENTITLED");
    expect(serviceWorker).toContain("school_not_entitled");
    expect(serviceWorker).toContain("if (isClassPilotNotEntitledResponse(data))");
  });

  it("uses throttled heartbeat FAB reconciliation when WebSocket delivery is unavailable", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toContain("requestFabState: requestFabStateOnHeartbeat()");
    expect(serviceWorker).toContain("FAB_HEARTBEAT_DISCONNECTED_SYNC_INTERVAL_MS = 30 * 1000");
    expect(serviceWorker).toContain("FAB_HEARTBEAT_CONNECTED_SYNC_INTERVAL_MS = 5 * 60 * 1000");
    expect(serviceWorker).toContain("Object.prototype.hasOwnProperty.call(data, 'fab')");
    expect(serviceWorker).toContain("reason: 'heartbeat-reconcile'");
  });

  it("keeps popup hand and chat controls independently bound to FAB toggles", () => {
    const popup = readRepoFile("extension/popup.js");
    expect(popup).toContain("chrome.storage.local.get(['handRaised', 'handRaisingEnabled'])");
    expect(popup).toContain("updateRaiseHandUI(handRaised, handRaisingEnabled)");
    expect(popup).toContain("chrome.storage.local.get(['messagingEnabled'])");
    expect(popup).toContain("updateChatUI(messagingEnabled)");
    expect(popup).toContain("changes.handRaisingEnabled || changes.messagingEnabled || changes.handRaised");
    expect(popup).toContain("if (!handRaisingEnabled)");
    expect(popup).toContain("if (!messagingEnabled)");
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

  it("keeps public IT tutorial privacy claims aligned with 2.7.3 behavior", () => {
    const tutorialMarkdown = readRepoFile("ClassPilot_IT_Tutorial.md");
    const tutorialHtml = readRepoFile("client/public/ClassPilot_IT_Tutorial.html");
    const alignedPrivacySurfaces = [
      tutorialMarkdown,
      tutorialHtml,
      readRepoFile("CLASSPILOT_USER_GUIDE.md"),
      readRepoFile("COPPA_FERPA_Compliance.md"),
      readRepoFile("client/index.html"),
      readRepoFile("client/src/pages/guides.tsx"),
      readRepoFile("client/src/pages/help.tsx"),
      readRepoFile("client/src/pages/settings.tsx"),
      readRepoFile("replit.md"),
    ];
    for (const copy of alignedPrivacySurfaces) {
      expect(copy).not.toContain("All-tabs data stored in-memory only");
      expect(copy).not.toContain("Explicit consent for screen sharing");
      expect(copy).not.toContain("only browsing activity");
      expect(copy).not.toContain("No personal information beyond school email");
      expect(copy).not.toContain("No keystroke logging, screenshot capture");
      expect(copy).not.toContain("Screen sharing requires explicit action");
      expect(copy).not.toContain("Data collected: Tab titles, URLs, and timestamps only");
      expect(copy).not.toContain("Screen sharing requires explicit student consent");
      expect(copy).not.toContain("Data is stored in-memory only for privacy");
      expect(copy).not.toContain("Voluntary student consent");
      expect(copy).not.toContain("No personal input data stored");
      expect(copy.toLowerCase()).not.toContain("opt-in screen sharing");
      expect(copy.toLowerCase()).not.toContain("record screen activity");
      expect(copy.toLowerCase()).not.toContain("transparent monitoring with clear consent");
      expect(copy).not.toContain("Outside these hours, no data is collected");
      expect(copy).not.toContain("automatically deleted after 24 hours");
      expect(copy).not.toContain("granted the necessary permissions to the extension");
    }
    for (const copy of [tutorialMarkdown, tutorialHtml]) {
      expect(copy).toContain("tracking-window thumbnail screenshots");
      expect(copy).toContain("gap/student-session pixels");
      expect(copy).toContain("school-scoped opaque ID");
      expect(copy).toContain("temporary encrypted stream");
      expect(copy).toContain("classroom communications");
    }
  });
});
