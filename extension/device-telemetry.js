(function attachClassPilotDeviceTelemetry(root) {
  'use strict';

  const MAX_FRAME_BYTES = 256 * 1024;
  const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const kinds = new Set(['heartbeat', 'screenshot']);

  function aborted() {
    const error = new Error('Telemetry authentication context changed');
    error.name = 'AbortError';
    error.code = 'AUTH_CONTEXT_SUPERSEDED';
    return error;
  }

  function sameIdentity(left, right) {
    return Boolean(left && right
      && left.connectionGeneration === right.connectionGeneration
      && left.authContextId === right.authContextId
      && left.serverOrigin === right.serverOrigin);
  }

  function createClient(options) {
    const pending = new Map();
    const activeKinds = new Set();
    const schedule = options.setTimeout || setTimeout;
    const clear = options.clearTimeout || clearTimeout;
    const encoder = new TextEncoder();
    const current = (context, identity) => {
      if (context.signal?.aborted) return false;
      try { return options.isCurrent(context, identity) === true; } catch { return false; }
    };

    function request(operation) {
      const { operationId, kind, context, identity, studentToken } = operation;
      if (!OPERATION_ID.test(operationId || '') || !kinds.has(kind)
        || typeof studentToken !== 'string' || !studentToken
        || !operation.payload || typeof operation.payload !== 'object'
        || Array.isArray(operation.payload) || !context || !identity) {
        return Promise.reject(new TypeError('Invalid telemetry operation'));
      }
      if (!current(context, identity) || operation.signal?.aborted) return Promise.reject(aborted());
      if (!options.isAvailable(context, identity) || activeKinds.has(kind) || pending.has(operationId)) {
        return Promise.resolve(null);
      }
      const frame = JSON.stringify({
        type: 'device-telemetry', operationId, kind, studentToken,
        payload: { ...operation.payload, telemetryOperationId: operationId },
      });
      if (encoder.encode(frame).byteLength > MAX_FRAME_BYTES) return Promise.resolve(null);

      return new Promise((resolve, reject) => {
        const signals = [...new Set([context.signal, operation.signal].filter(Boolean))];
        let timer;
        const entry = {
          kind, context, identity,
          finish(value, error) {
            if (pending.get(operationId) !== entry) return;
            pending.delete(operationId);
            activeKinds.delete(kind);
            if (timer !== undefined) clear(timer);
            for (const signal of signals) signal.removeEventListener('abort', onAbort);
            if (error) reject(error); else resolve(value);
          },
        };
        const onAbort = () => entry.finish(null, aborted());
        pending.set(operationId, entry);
        activeKinds.add(kind);
        for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
        timer = schedule(() => entry.finish(null, current(context, identity) ? null : aborted()),
          Math.min(1500, Math.max(1, Number(operation.timeoutMs) || 1500)));
        if (signals.some(signal => signal.aborted)) return onAbort();
        // A successful send confirms only that the offscreen owner wrote a
        // frame. Completion requires a separate exact canonical server result.
        Promise.resolve().then(() => {
          if (pending.get(operationId) !== entry || !current(context, identity)) return false;
          return options.send(frame, context, identity);
        }).then(sent => {
          if (!sent) entry.finish(null, current(context, identity) ? null : aborted());
        }, () => entry.finish(null, current(context, identity) ? null : aborted()));
      });
    }

    function acceptResult(message, identity) {
      if (message?.type !== 'device-telemetry-result') return false;
      const entry = pending.get(message.operationId);
      if (!entry || message.kind !== entry.kind || !sameIdentity(identity, entry.identity)
        || !Number.isInteger(message.status) || message.status < 200 || message.status > 599
        || !message.body || typeof message.body !== 'object' || Array.isArray(message.body)
        || message.exactBinding?.studentId !== entry.context.studentId
        || message.exactBinding?.studentSessionId !== entry.context.studentSessionId) return false;
      if (!current(entry.context, entry.identity)) {
        entry.finish(null, aborted());
        return false;
      }
      const headers = {};
      const retryAfter = message.headers?.['retry-after'];
      if (typeof retryAfter === 'string' && retryAfter.length <= 128 && !/[\r\n]/.test(retryAfter)) {
        headers['retry-after'] = retryAfter;
      }
      entry.finish({ status: message.status, body: message.body, headers });
      return true;
    }

    function cancelConnection(identity) {
      for (const entry of [...pending.values()]) {
        if (sameIdentity(identity, entry.identity)) {
          entry.finish(null, current(entry.context, entry.identity) ? null : aborted());
        }
      }
    }

    return Object.freeze({ request, acceptResult, cancelConnection });
  }

  root.ClassPilotDeviceTelemetry = Object.freeze({ createClient });
})(globalThis);
