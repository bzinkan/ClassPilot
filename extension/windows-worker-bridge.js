/* global CONFIG, EXTENSION_CAPABILITIES, authStateRestorePromise, managedAuthGatePolicyRestorePromise,
  setManualAuthState, studentAuthMutationGeneration, studentAuthInvalidating, generateAuthContextId,
  activateAuthenticatedContext, captureAuthenticatedContext, enqueueStudentAuthMutation,
  adoptNegotiatedProtocolState, applyLoginClassroomStateAndCommit, activateLicenseForAuthenticatedResponse,
  clearStudentAuth, handleWsMessage, wsConnectionGeneration, sendHeartbeat, fetchWithBackoff,
  safeSendHeartbeat, durableLocalKv, STUDENT_AUTH_INVALIDATING_KEY,
  classroomStateApplicationTail, currentStudentControlRevision, beginStudentAuthCommit, capturePendingAuthenticatedContext, refreshSchoolSettings, updateTrackingState */
(function () {
  'use strict';
  const build = globalThis.CLASSPILOT_WINDOWS_BUILD;
  if (!build || !['chrome', 'edge'].includes(build.browserFamily)) throw new Error('WINDOWS_BUILD_INVALID');
  const originalFetch = globalThis.fetch.bind(globalThis);
  const origin = () => {
    const value = new URL(CONFIG.serverUrl);
    if (value.pathname !== '/' || value.username || value.password || value.search || value.hash
      || (value.protocol !== 'https:' && !(build.development === true && value.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(value.hostname)))) {
      throw new Error('WINDOWS_SERVER_ORIGIN_INVALID');
    }
    return value.origin;
  };
  const adapter = globalThis.ClassPilotWindowsChannel.create({
    runtime: chrome.runtime, storage: chrome.storage.local, fetch: originalFetch, origin, browserFamily: build.browserFamily,
    capabilities: () => EXTENSION_CAPABILITIES.filter(name => !['managedDeviceContinuityV1', 'liveViewIceServersV1', 'kioskLaunchTicketV1', 'kioskLaunchTicketV2', 'liveViewNegotiationV1', 'safetyEvidenceCaptureV1', 'screenshotObservationLeaseV1', 'screenshotReadOnlyObservationV1'].includes(name)),
    invalidate: reason => clearStudentAuth(reason, { notifyBackend: false, pauseAutoRegistration: true, disconnectWebSocket: true }),
    frame: value => handleWsMessage(JSON.stringify(value), wsConnectionGeneration, captureAuthenticatedContext('Windows browser frame')),
    ready: async () => {
      const context=captureAuthenticatedContext('Windows policy readiness');
      await refreshSchoolSettings({force:true,authContext:context});
      await updateTrackingState('windows-paired');
    },
    adopt: (response, assertCurrent) => enqueueStudentAuthMutation(async () => {
      await authStateRestorePromise;
      await managedAuthGatePolicyRestorePromise;
      assertCurrent();
      const mutation = studentAuthMutationGeneration;
      await beginStudentAuthCommit(mutation, 'Windows pairing commit'); assertCurrent();
      const identity = { authContextId: generateAuthContextId(), studentToken: response.studentToken,
        deviceId: response.deviceId, activeStudentId: response.studentId, activeStudentSessionId: response.studentSessionId,
        identitySource: 'windows_guard', studentName: response.student?.displayName || 'Student', registered: true,
        autoRegistrationPaused: true, manualLoginLastSeenAt: Date.now() };
      await setManualAuthState(identity); assertCurrent();
      await durableLocalKv.remove(STUDENT_AUTH_INVALIDATING_KEY); assertCurrent();
      if (mutation !== studentAuthMutationGeneration) throw new Error('WINDOWS_AUTH_RETIRED');
      Object.assign(CONFIG, identity, { schoolId: response.schoolId, classId: 'auto' });
      studentAuthInvalidating = false;
      activateAuthenticatedContext(identity.authContextId);
      const context = capturePendingAuthenticatedContext('Windows pairing', mutation);
      adoptNegotiatedProtocolState(response, context);
      await applyLoginClassroomStateAndCommit(response, 'windows_pairing', context, mutation, assertCurrent);
      assertCurrent();
      await activateLicenseForAuthenticatedResponse(context, response.planStatus, { notify: false });
      assertCurrent();
    }),
  });
  globalThis.ClassPilotWindows = adapter;
  const sharedHeartbeat = sendHeartbeat;
  sendHeartbeat = async (...args) => { await sharedHeartbeat(...args); await classroomStateApplicationTail; await adapter.drain(); };
  const sharedBackoff = fetchWithBackoff;
  let heartbeatSequence = 0, screenshotSequence = 0;
  fetchWithBackoff = async (url, init = {}, options = {}) => {
    const operation = adapter.route(new URL(url, origin()).pathname);
    if (['heartbeat', 'screenshot'].includes(operation)) {
      const sequence = operation === 'heartbeat' ? ++heartbeatSequence : ++screenshotSequence;
      if (!Number.isSafeInteger(sequence)) throw new Error('WINDOWS_SEQUENCE_EXHAUSTED');
      const input = JSON.parse(init.body || '{}');
      init = { ...init, body: JSON.stringify({ ...input, sequence,
        ...(operation === 'heartbeat' ? { observationId: crypto.randomUUID() } : { capturedAt: input.capturedAt || new Date().toISOString() }) }) };
    }
    return sharedBackoff(url, init, options);
  };
  const actions = [
    [/^\/api\/school\/status$/, 'school-status'],
    [/^\/api\/extension\/settings$/, 'settings'],
    [/^\/api\/classpilot\/device\/chat-acks$/, 'chat-acks'],
    [/^\/api\/classpilot\/device\/events$/, 'events'],
    [/^\/api\/classpilot\/device\/school-policy-acks$/, 'school-policy-acks'],
    [/^\/api\/student\/(raise-hand|lower-hand|send-message)$/, null],
    [/^\/api\/polls\/([^/]+)\/respond$/, 'poll-respond'],
    [/^\/api\/classpilot\/student\/class-tools\/([a-z-]+)$/, 'class-tools'],
  ];
  globalThis.fetch = async (input, init = {}) => {
    const value = new URL(typeof input === 'string' ? input : input.url, origin());
    if (value.origin !== origin() || !value.pathname.startsWith('/api/')) return originalFetch(input, init);
    const operation = adapter.route(value.pathname);
    if (operation) {
      if (operation === 'heartbeat') {
        const focused = await chrome.windows.getLastFocused().catch(() => null);
        init = { ...init, body: JSON.stringify({ ...JSON.parse(init.body || '{}'), browserFocused: focused?.focused === true }) };
      }
      return adapter.request(operation, init);
    }
    if (/^\/api\/(?:extension\/(?:student-login|register|session-release|session-gate-presence)|register)$/.test(value.pathname)) {
      return Response.json({ code: 'WINDOWS_APP_SIGN_IN_REQUIRED', error: 'Sign in using the ClassPilot Windows app.' }, { status: 409 });
    }
    for (const [pattern, fixed] of actions) {
      const match = value.pathname.match(pattern);
      if (!match) continue;
      const payload = JSON.parse(init.body || '{}');
      delete payload.studentToken;
      if (!['settings', 'school-status', 'events'].includes(fixed)) {
        payload.studentControlRevision = currentStudentControlRevision();
      }
      if (fixed === 'poll-respond') payload.pollId = decodeURIComponent(match[1]);
      const tool = fixed === 'class-tools' && match[1] === 'help' && String(init.method || 'GET').toUpperCase() === 'DELETE'
        ? 'help-withdraw' : match[1];
      const action = fixed === 'class-tools' ? `class-tools:${tool}` : fixed || match[1];
      return adapter.request('action', { ...init, body: JSON.stringify({ operation: action, payload }) });
    }
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : {}));
    if (headers.get('Authorization')?.startsWith('Bearer cpw1.browser.')) {
      // Never send a Windows child credential to a legacy browser endpoint.
      throw Object.assign(new Error('WINDOWS_OPERATION_UNSUPPORTED'), { code: 'WINDOWS_OPERATION_UNSUPPORTED' });
    }
    return originalFetch(input, init);
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'windows-browser-status' || sender.id !== chrome.runtime.id) return undefined;
    try {
      const source = adapter.active(); respond({ authorized: true, browserFamily: build.browserFamily,
        sourceRef: source.sourceRef, bindingRevision: source.bindingRevision });
    } catch { respond({ authorized: false, browserFamily: build.browserFamily, reason: 'Sign in using the ClassPilot Windows app.' }); }
    return false;
  });
  setInterval(() => { void safeSendHeartbeat('windows-command-poll').catch(() => {}); }, 5000);
})();
