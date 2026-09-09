// Bounded operational diagnostics. No identity, policy, URL or payload data.
(() => {
  'use strict';
  const KEY = 'authGateDiagnosticsV1';
  const LIMIT = 20;
  const STAGES = new Set(['policy_read', 'startup', 'message_transport', 'server_request', 'login_config', 'roster', 'login_mutation', 'script_recovery']);
  const CAUSES = new Set(['timeout', 'channel_closed', 'context_invalidated', 'http_failure', 'network_failure', 'invalid_payload', 'internal', 'recovered', 'reload_required']);
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
