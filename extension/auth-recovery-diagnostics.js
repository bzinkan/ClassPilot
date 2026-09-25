// Bounded operational diagnostics. No identity, policy, URL or payload data.
(() => {
  'use strict';
  const KEY = 'authGateDiagnosticsV1';
  const LIMIT = 20;
  const STAGES = new Set(['policy_read', 'startup', 'message_transport', 'server_request', 'login_config', 'roster', 'login_mutation', 'script_recovery']);
  const CAUSES = new Set(['timeout', 'channel_closed', 'context_invalidated', 'http_failure', 'network_failure', 'invalid_payload', 'internal', 'recovered', 'reload_required', 'reconciled', 'stalled', 'superseded_joined', 'policy_churn', 'wake_failed', 'wake_abandoned']);
  const STAGE_ALIASES = Object.freeze({
    runtime_rpc: 'message_transport', frame_state: 'message_transport', frame_refresh: 'message_transport',
    bootstrap_rpc: 'message_transport', content_rpc: 'message_transport', frame_roster: 'roster',
    frame_login: 'login_mutation', frame_login_confirmation: 'login_mutation',
  });
  const CAUSE_ALIASES = Object.freeze({
    AUTH_GATE_RPC_TIMEOUT: 'timeout', AUTH_GATE_STARTUP_TIMEOUT: 'timeout', AUTH_GATE_POLICY_TIMEOUT: 'timeout',
    AUTH_GATE_TIMEOUT: 'timeout', AUTH_GATE_SERVER_TIMEOUT: 'timeout', AUTH_GATE_CONTEXT_INVALIDATED: 'context_invalidated',
    AUTH_GATE_RPC_UNAVAILABLE: 'channel_closed', AUTH_GATE_UNAVAILABLE: 'internal',
    AUTH_GATE_POLICY_UNAVAILABLE: 'internal', AUTH_GATE_LOGIN_PENDING: 'internal',
  });

  // Shared by the worker and every gate surface. Identifier-shaped strings are
  // not safe diagnostics: only these shipped operation names may cross realms.
  const SUPPORT_STEPS = new Set([
    'unknown', 'worker_unavailable', 'start', 'auth_snapshot', 'auth_restore',
    'legacy_auth_cleanup', 'auth_context_persist', 'retired_storage_cleanup',
    'managed_policy', 'sso_cleanup', 'session_recovery', 'monitoring_redaction',
    'roster_context', 'classroom_snapshot', 'outbox_compaction', 'inbox_reconcile',
    'fab_restore', 'school_policy', 'classroom_state', 'signed_out_clear',
    'license', 'connectivity', 'tracking', 'recovery_clear', 'recovery_policy',
    'recovery_policy_read', 'recovery_policy_persist', 'recovery_policy_cleanup', 'recovery_publication', 'readiness',
  ]);
  const SUPPORT_CODES = new Set([
    'AUTH_GATE_POLICY_TIMEOUT', 'AUTH_GATE_POLICY_UNAVAILABLE', 'AUTH_GATE_STARTUP_TIMEOUT',
    'AUTH_GATE_RPC_TIMEOUT', 'AUTH_GATE_RPC_UNAVAILABLE', 'AUTH_GATE_CONTEXT_INVALIDATED',
    'AUTH_GATE_SERVER_TIMEOUT', 'AUTH_GATE_LOGIN_PENDING', 'AUTH_GATE_UNAVAILABLE',
  ]);
  const FAILURE_CLASSES = new Set([
    ...SUPPORT_CODES, 'AUTH_GATE_TIMEOUT', 'AUTH_MUTATION_SUPERSEDED',
    'STORAGE_QUOTA_EXCEEDED', 'STORAGE_IO_ERROR', 'STORAGE_CONTEXT_INVALIDATED', 'STORAGE_FAILED',
    'RECOVERY_STORE_UNAVAILABLE', 'RECOVERY_STORE_READ_FAILED',
    'RECOVERY_STORE_WRITE_FAILED', 'RECOVERY_STORE_MIGRATION_FAILED',
    'AbortError', 'DOMException', 'Error', 'NetworkError', 'NotAllowedError', 'NotFoundError',
    'OperationError', 'QuotaExceededError', 'SecurityError', 'TimeoutError', 'TypeError', 'pending',
  ]);
  const RESTORE_OUTCOMES = new Set(['pending', 'verified', 'failed', 'superseded']);
  const STORAGE_ACCESS_PHASES = new Set(['opening', 'reading', 'migrating', 'purging', 'writing', 'ready', 'failed']);
  const STORAGE_ACCESS_FAILURES = new Set([
    'RECOVERY_STORE_UNAVAILABLE', 'RECOVERY_STORE_READ_FAILED',
    'RECOVERY_STORE_WRITE_FAILED', 'RECOVERY_STORE_MIGRATION_FAILED',
  ]);
  const boundedNumber = (value, maximum, fallback = 0) => typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(0, Math.floor(value))) : fallback;
  const safeVersion = value => typeof value === 'string' && /^(?:\d{1,5}(?:\.\d{1,5}){0,3}|unknown)$/.test(value)
    ? value : 'unknown';

  function sanitizeSupportDetails(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const access = value.storageAccess;
    const storageAccess = access && typeof access === 'object' && !Array.isArray(access)
      && STORAGE_ACCESS_PHASES.has(access.phase)
      ? { phase: access.phase, attemptCount: boundedNumber(access.attemptCount, 100),
        ...(STORAGE_ACCESS_FAILURES.has(access.failureClass) ? { failureClass: access.failureClass } : {}) }
      : null;
    const first = value.firstFailure;
    const firstFailure = first && typeof first === 'object'
      && SUPPORT_STEPS.has(first.startupPhase) && FAILURE_CLASSES.has(first.failureClass)
      && typeof first.timestamp === 'number' && Number.isFinite(first.timestamp)
      && first.timestamp >= 0 && first.timestamp <= 8_640_000_000_000_000
      ? { startupPhase: first.startupPhase, failureClass: first.failureClass, timestamp: Math.floor(first.timestamp) }
      : null;
    return {
      extensionVersion: safeVersion(value.extensionVersion),
      timestamp: boundedNumber(value.timestamp, 8_640_000_000_000_000),
      startupPhase: SUPPORT_STEPS.has(value.startupPhase) ? value.startupPhase : 'unknown',
      failureClass: FAILURE_CLASSES.has(value.failureClass) ? value.failureClass : 'Error',
      ...(typeof value.elapsedMs === 'number' && Number.isFinite(value.elapsedMs)
        ? { elapsedMs: boundedNumber(value.elapsedMs, 60_000) } : {}),
      ...(RESTORE_OUTCOMES.has(value.restoreOutcome) ? { restoreOutcome: value.restoreOutcome } : {}),
      ...(typeof value.attemptCount === 'number' && Number.isFinite(value.attemptCount)
        ? { attemptCount: boundedNumber(value.attemptCount, 100) } : {}),
      ...(typeof value.retryInMs === 'number' && Number.isFinite(value.retryInMs)
        ? { retryInMs: boundedNumber(value.retryInMs, 300_000) } : {}),
      ...(typeof value.pending === 'boolean' ? { pending: value.pending } : {}),
      ...(firstFailure ? { firstFailure } : {}),
      ...(storageAccess ? { storageAccess } : {}),
    };
  }

  function localSupportDetails(code) {
    let version = 'unknown';
    try { version = globalThis.chrome?.runtime?.getManifest()?.version; } catch { /* retired context */ }
    return sanitizeSupportDetails({ extensionVersion: version, startupPhase: 'worker_unavailable',
      timestamp: Date.now(), failureClass: SUPPORT_CODES.has(code) ? code : 'AUTH_GATE_RPC_UNAVAILABLE' });
  }

  function retainFirstFailure(previous, value, code) {
    const details = sanitizeSupportDetails(value) || localSupportDetails(code);
    const firstFailure = sanitizeSupportDetails(previous)?.firstFailure;
    return firstFailure ? { ...details, firstFailure } : details;
  }

  function formatSupportDetails(value, code) {
    const details = sanitizeSupportDetails(value) || localSupportDetails(code);
    const lines = [
      `ClassPilot ${details.extensionVersion}`,
      `Support code: ${SUPPORT_CODES.has(code) ? code : 'AUTH_GATE_UNAVAILABLE'}`,
      `Recorded at: ${new Date(details.timestamp).toISOString()}`,
      ...(details.elapsedMs !== undefined ? [
        `${details.startupPhase === 'worker_unavailable' ? 'Page request elapsed' : 'Elapsed'}: ${details.elapsedMs} ms`,
      ] : []),
      `Startup step: ${details.startupPhase}`,
      ...(details.restoreOutcome !== undefined ? [`Restore: ${details.restoreOutcome}`] : []),
      `Failure class: ${details.failureClass}`,
      ...(details.attemptCount !== undefined ? [`Recovery attempt: ${details.attemptCount}`] : []),
      ...(details.pending !== undefined ? [`Operation pending: ${details.pending ? 'yes' : 'no'}`] : []),
      ...(details.retryInMs !== undefined ? [`Retry in: ${Math.ceil(details.retryInMs / 1000)} seconds`] : []),
    ];
    if (details.firstFailure) lines.push(
      `First failure: ${details.firstFailure.startupPhase} / ${details.firstFailure.failureClass}`,
      `First failure time: ${new Date(details.firstFailure.timestamp).toISOString()}`,
    );
    if (details.storageAccess) lines.push(
      `Private recovery storage: ${details.storageAccess.phase}`,
      `Private recovery storage attempt: ${details.storageAccess.attemptCount}`,
      ...(details.storageAccess.failureClass ? [`Private recovery storage failure: ${details.storageAccess.failureClass}`] : []),
    );
    if (details.startupPhase === 'worker_unavailable') lines.push('Worker details unavailable; this is the page connection status.');
    return lines.join('\n');
  }

  // A repaint replaces controls while a native clipboard promise may still
  // be pending. Transfer ownership only through a presentation captured from
  // this module's own mounted details block, without trusting mutable DOM text.
  const supportCopyOwners = new WeakMap();
  const supportPresentationCopyOwners = new WeakMap();

  function captureSupportPresentation(container) {
    const details = container?.querySelector('#classpilot-auth-it-details');
    const active = details?.ownerDocument.activeElement;
    const presentation = { open: details?.open === true,
      focusId: details?.contains(active) ? active.id : null,
      selectionStart: active?.selectionStart, selectionEnd: active?.selectionEnd,
      selectionWasFull: active?.selectionStart === 0
        && active?.selectionEnd === active?.value?.length };
    const copyOwner = supportCopyOwners.get(details);
    if (copyOwner) supportPresentationCopyOwners.set(presentation, copyOwner);
    return presentation;
  }

  function mountSupportDetails(container, value, code, presentation = {}) {
    if (!container) return null;
    const doc = container.ownerDocument;
    const details = doc.createElement('details');
    details.id = 'classpilot-auth-it-details';
    details.open = presentation.open === true;
    details.style.cssText = 'margin:12px 0!important;font-size:12px!important;line-height:1.5!important;color:#526174!important';
    const summary = doc.createElement('summary');
    summary.id = 'classpilot-auth-it-summary';
    summary.textContent = 'Details for IT';
    summary.style.cssText = 'cursor:pointer!important;user-select:none!important';
    const text = doc.createElement('textarea');
    text.id = 'classpilot-auth-it-text';
    text.readOnly = true;
    text.rows = 8;
    text.setAttribute('aria-label', 'ClassPilot diagnostics for IT');
    const formattedText = formatSupportDetails(value, code);
    text.value = formattedText;
    text.style.cssText = 'display:block!important;box-sizing:border-box!important;width:100%!important;max-width:100%!important;margin:8px 0!important;padding:8px!important;font:12px/1.5 monospace!important;resize:vertical!important;user-select:text!important;white-space:pre-wrap!important;color:#25364a!important;background:#fff!important;border:1px solid #ccd5df!important;border-radius:6px!important';
    const button = doc.createElement('button');
    button.type = 'button';
    button.id = 'classpilot-auth-copy-diagnostics';
    button.textContent = 'Copy diagnostics';
    button.style.cssText = 'font:inherit!important;cursor:pointer!important;padding:6px 10px!important;color:#25364a!important;background:#fff!important;border:1px solid #aab7c5!important;border-radius:6px!important';
    const status = doc.createElement('span');
    status.id = 'classpilot-auth-copy-status';
    status.setAttribute('role', 'status');
    status.style.cssText = 'display:block!important;margin-top:5px!important';
    const copyOwner = supportPresentationCopyOwners.get(presentation)
      || { generation: 0, status: '' };
    copyOwner.target = { details, text, status, formattedText };
    supportCopyOwners.set(details, copyOwner);
    status.textContent = copyOwner.status;
    const finishCopy = (generation, denied) => {
      const target = copyOwner.target;
      if (generation !== copyOwner.generation || !target?.details.isConnected) return;
      copyOwner.status = denied ? 'Select and copy the details above.' : 'Diagnostics copied.';
      if (denied) {
        target.details.open = true;
        target.text.value = target.formattedText;
        target.text.focus(); target.text.select();
      }
      target.status.textContent = copyOwner.status;
    };
    const copy = async () => {
      const generation = ++copyOwner.generation;
      try {
        const clipboard = doc.defaultView?.navigator?.clipboard;
        if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
        await clipboard.writeText(formattedText);
        finishCopy(generation, false);
      } catch {
        finishCopy(generation, true);
      }
    };
    button.addEventListener('click', copy);
    details.append(summary, text, button, status);
    container.append(details);
    if (presentation.focusId) {
      const control = [summary, text, button].find(item => item.id === presentation.focusId);
      control?.focus({ preventScroll: true });
      if (control === text && Number.isInteger(presentation.selectionStart)) {
        if (copyOwner.status === 'Select and copy the details above.'
          && presentation.selectionWasFull) text.select();
        else text.setSelectionRange(presentation.selectionStart, presentation.selectionEnd);
      }
    }
    return { details, summary, text, button, copy,
      owns: target => target === summary || target === text || target === button };
  }

  globalThis.ClassPilotAuthSupportDetails = Object.freeze({
    sanitize: sanitizeSupportDetails, format: formatSupportDetails, fallback: localSupportDetails,
    retainFirstFailure,
    capture: captureSupportPresentation, mount: mountSupportDetails,
  });

  function createRecorder(options = {}) {
    const clock = options.now || Date.now;
    const runtime = options.runtime;
    const storage = options.storage;
    const warn = options.warn || (() => {});
    const relay = options.relay;
    const version = /^\d+(?:\.\d+){0,3}$/.test(String(options.version || ''))
      ? String(options.version) : 'unknown';
    let records = [];
    const recent = new Map();
    let loaded = !storage;
    let inFlight = false;
    let dirty = false;

    function safeRecord(value) {
      if (!value || !STAGES.has(value.stage) || !CAUSES.has(value.cause)) return null;
      if (!Number.isFinite(value.timestamp) || value.timestamp < 0) return null;
      if (!/^(?:\d+(?:\.\d+){0,3}|unknown)$/.test(String(value.extensionVersion))) return null;
      return {
        timestamp: Math.floor(value.timestamp),
        extensionVersion: String(value.extensionVersion),
        stage: value.stage,
        cause: value.cause,
        elapsedMs: Math.min(60_000, Math.max(0, Math.round(Number(value.elapsedMs) || 0))),
        attemptCount: Math.min(100, Math.max(1, Math.floor(Number(value.attemptCount) || 1))),
        // Optional seventh field (2.9.4): a fixed startup step name, never data.
        ...(SUPPORT_STEPS.has(value.detail)
          ? { detail: value.detail } : {}),
      };
    }

    function flush() {
      if (!storage || inFlight || !dirty) return;
      inFlight = true;
      if (!loaded) {
        let settled = false;
        const complete = (stored) => {
          if (settled) return;
          settled = true;
          void runtime?.lastError;
          loaded = true;
          const prior = Array.isArray(stored?.[KEY]) ? stored[KEY].slice(-LIMIT).map(safeRecord).filter(Boolean) : [];
          const unique = new Map();
          for (const record of [...prior, ...records]) {
            unique.set(`${record.timestamp}:${record.stage}:${record.cause}`, record);
          }
          records = [...unique.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-LIMIT);
          inFlight = false;
          flush();
        };
        try { storage.get([KEY], complete); } catch { complete(null); }
        return;
      }
      dirty = false;
      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true;
        void runtime?.lastError;
        inFlight = false;
        if (dirty) flush();
      };
      try { storage.set({ [KEY]: records.map((entry) => ({ ...entry })) }, complete); }
      catch { complete(); }
    }

    function record(value = {}) {
      if (!value || typeof value !== 'object') return false;
      value = { ...value, stage: STAGE_ALIASES[value.stage] || value.stage, cause: CAUSE_ALIASES[value.cause] || value.cause };
      if (!STAGES.has(value.stage) || !CAUSES.has(value.cause)) return false;
      const timestamp = clock();
      const fingerprint = `${value.stage}:${value.cause}`;
      const previous = recent.get(fingerprint);
      if (previous !== undefined && timestamp >= previous && timestamp - previous < 60_000) return false;
      recent.set(fingerprint, timestamp);
      const safe = safeRecord({ ...value, timestamp, extensionVersion: version });
      if (!safe) return false;
      records.push(safe);
      records = records.slice(-LIMIT);
      try { warn('[AuthGateRecovery]', { ...safe }); } catch { /* diagnostics never gate work */ }
      if (relay) {
        try { relay({ ...safe }); } catch { /* keep the local record when transport is unavailable */ }
      }
      dirty = true;
      flush();
      return true;
    }

    return Object.freeze({ record, snapshot: () => records.map((entry) => ({ ...entry })) });
  }

  globalThis.ClassPilotAuthRecoveryDiagnosticsFactory = Object.freeze({ createRecorder });
  if (globalThis.ClassPilotAuthRecoveryDiagnostics) return;
  let version = 'unknown';
  try { version = chrome.runtime.getManifest().version; } catch { /* invalidated extension context */ }
  const worker = typeof document === 'undefined';
  globalThis.ClassPilotAuthRecoveryDiagnostics = createRecorder({
    version,
    runtime: globalThis.chrome?.runtime,
    storage: worker ? globalThis.chrome?.storage?.session : null,
    warn: (...args) => console.warn(...args),
    relay: worker ? null : (diagnostic) => chrome.runtime.sendMessage(
      { type: 'record-auth-gate-diagnostic', diagnostic },
      () => { void chrome.runtime.lastError; },
    ),
  });
})();
