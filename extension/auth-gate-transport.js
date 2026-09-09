// Bounded, cancellable runtime messages. Transport failure carries no auth proof.
(() => {
  'use strict';
  if (globalThis.ClassPilotAuthGateTransport) return;

  const FAILURE_CODES = new Set([
    'AUTH_GATE_RPC_TIMEOUT', 'AUTH_GATE_CONTEXT_INVALIDATED',
    'AUTH_GATE_RPC_UNAVAILABLE', 'AUTH_GATE_REQUEST_CANCELLED',
    'AUTH_GATE_POLICY_TIMEOUT', 'AUTH_GATE_POLICY_UNAVAILABLE', 'AUTH_GATE_STARTUP_TIMEOUT',
    'AUTH_GATE_SERVER_TIMEOUT',
    'AUTH_GATE_LOGIN_PENDING',
    'AUTH_GATE_UNAVAILABLE',
  ]);

  function failure(code, retryAt) {
    const safeCode = FAILURE_CODES.has(code) ? code : 'AUTH_GATE_RPC_UNAVAILABLE';
    const error = new Error(safeCode);
    error.code = safeCode;
    error.errorCode = safeCode;
    const hintedRetry = Number(retryAt);
    error.retryAt = Number.isFinite(hintedRetry) && hintedRetry >= Date.now()
      ? Math.min(hintedRetry, Date.now() + 5 * 60_000)
      : Date.now() + 2_000;
    return error;
  }

  function runtimeFailure(error) {
    // Inspect only to classify locally; never retain or report raw runtime text.
    let invalidated = false;
    try { invalidated = /extension context invalidated/i.test(String(error?.message || '')); } catch (_error) { /* fixed fallback */ }
    return failure(invalidated ? 'AUTH_GATE_CONTEXT_INVALIDATED' : 'AUTH_GATE_RPC_UNAVAILABLE');
  }

  function sendMessage(message, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.min(10_000, Math.max(1, options.timeoutMs)) : 10_000;
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const isCurrent = () => {
        try { return !options.signal?.aborted && (typeof options.isCurrent !== 'function' || options.isCurrent()); }
        catch (_error) { return false; }
      };
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (error) {
          if (error.code !== 'AUTH_GATE_REQUEST_CANCELLED') {
            try {
              globalThis.ClassPilotAuthRecoveryDiagnostics?.record({
                stage: options.stage || 'runtime_rpc',
                cause: error.code,
                elapsedMs: Math.max(0, Date.now() - startedAt),
                attemptCount: Number.isSafeInteger(options.attemptCount) ? options.attemptCount : 1,
              });
            } catch (_error) { /* Diagnostics cannot affect gate behavior. */ }
          }
          reject(error);
        } else resolve(response);
      };
      const onAbort = () => finish(failure('AUTH_GATE_REQUEST_CANCELLED'));
      if (!isCurrent()) { onAbort(); return; }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(failure(isCurrent() ? 'AUTH_GATE_RPC_TIMEOUT' : 'AUTH_GATE_REQUEST_CANCELLED')), timeoutMs);
      try {
        chrome.runtime.sendMessage(message, response => {
          // Consume lastError even for a late callback, without letting it mutate UI.
          let runtimeError;
          try { runtimeError = chrome.runtime.lastError; } catch (error) { runtimeError = error; }
          if (settled) return;
          if (!isCurrent()) { onAbort(); return; }
          if (runtimeError) { finish(runtimeFailure(runtimeError)); return; }
          if (!response || typeof response !== 'object') { finish(failure('AUTH_GATE_RPC_UNAVAILABLE')); return; }
          if (response.success === false && FAILURE_CODES.has(response.errorCode)) {
            finish(failure(response.errorCode, response.retryAt)); return;
          }
          finish(null, response);
        });
      } catch (error) { finish(runtimeFailure(error)); }
    });
  }

  globalThis.ClassPilotAuthGateTransport = Object.freeze({ sendMessage });
})();
