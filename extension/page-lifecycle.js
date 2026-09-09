// Isolated-world ownership for page scripts. Never modifies page prototypes.
(() => {
  'use strict';
  if (globalThis.ClassPilotPageLifecycle?.protocol === 1) return;

  const controllers = new Map();
  const native = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    requestAnimationFrame: globalThis.requestAnimationFrame?.bind(globalThis),
    cancelAnimationFrame: globalThis.cancelAnimationFrame?.bind(globalThis),
    queueMicrotask: globalThis.queueMicrotask.bind(globalThis),
    MutationObserver: globalThis.MutationObserver,
  };
  const runtime = globalThis.chrome;
  const capture = options => typeof options === 'boolean' ? options : options?.capture === true;
  const cancellation = () => Object.assign(new Error('ClassPilot page instance retired'), {
    code: 'AUTH_GATE_REQUEST_CANCELLED', errorCode: 'AUTH_GATE_REQUEST_CANCELLED',
  });

  function begin(kind, { legacyFlag, legacyControllerKey } = {}) {
    const version = runtime.runtime.getManifest().version;
    const prior = controllers.get(kind);
    if (prior?.active && prior.version === version) {
      prior.reconcile();
      return { action: 'existing', controller: prior };
    }
    if (!prior && legacyFlag && globalThis[legacyFlag]) return { action: 'legacy' };
    // Content owns the inner quarantine snapshot. Retire it before bootstrap.
    if (kind === 'bootstrap') controllers.get('content')?.dispose();
    prior?.dispose();

    let active = true;
    let hooks = {};
    const abort = new AbortController();
    const cleanups = new Set();
    const cleanupFinalizer = new FinalizationRegistry(cleanup => cleanups.delete(cleanup));
    const timeouts = new Set();
    const intervals = new Set();
    const animationFrames = new Set();
    const listeners = new WeakMap();
    const ownedNodes = new WeakMap();
    const events = new WeakMap();
    const instanceId = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    const guard = fn => function (...args) { if (active) return fn.apply(this, args); };
    const onDispose = (fn, weakOwner = null) => {
      if (active) {
        cleanups.add(fn);
        if (weakOwner) cleanupFinalizer.register(weakOwner, fn, fn);
      } else fn();
      return fn;
    };
    const forgetCleanup = fn => { cleanups.delete(fn); cleanupFinalizer.unregister(fn); };

    function listen(target, type, listener, options) {
      if (!active || !target || !listener) return;
      let byType = listeners.get(target);
      if (!byType) { byType = new Map(); listeners.set(target, byType); }
      const key = `${type}:${capture(options)}`;
      let byListener = byType.get(key);
      if (!byListener) { byListener = new Map(); byType.set(key, byListener); }
      if (byListener.has(listener)) return;
      const wrapped = function (...args) {
        if (options?.once) { byListener.delete(listener); forgetCleanup(cleanup); }
        if (!active) return;
        return typeof listener === 'function' ? listener.apply(this, args) : listener.handleEvent(...args);
      };
      let cleanup;
      byListener.set(listener, { wrapped, removeCleanup: () => forgetCleanup(cleanup) });
      target.addEventListener(type, wrapped, options);
      // Detached UI nodes must remain collectible during a long school day.
      const targetRef = new WeakRef(target), listenerRef = new WeakRef(wrapped);
      cleanup = onDispose(() => {
        const liveTarget = targetRef.deref(), liveListener = listenerRef.deref();
        if (liveTarget && liveListener) liveTarget.removeEventListener(type, liveListener, { capture: capture(options) });
      }, target);
    }

    function unlisten(target, type, listener, options) {
      if (!target) return;
      const byListener = listeners.get(target)?.get(`${type}:${capture(options)}`);
      const registration = byListener?.get(listener);
      const wrapped = registration?.wrapped;
      target.removeEventListener(type, wrapped || listener, { capture: capture(options) });
      registration?.removeCleanup();
      byListener?.delete(listener);
    }

    function chromeEvent(event) {
      if (events.has(event)) return events.get(event);
      const registered = new Map();
      const result = {
        addListener(listener) {
          if (!active || registered.has(listener)) return;
          const wrapped = guard(listener);
          registered.set(listener, wrapped);
          event.addListener(wrapped);
        },
        removeListener(listener) {
          const wrapped = registered.get(listener);
          if (wrapped) event.removeListener(wrapped);
          registered.delete(listener);
        },
        hasListener(listener) { return registered.has(listener); },
      };
      onDispose(() => { for (const listener of registered.values()) event.removeListener(listener); registered.clear(); });
      events.set(event, result);
      return result;
    }

    function api(nativeApi, overrides = {}) {
      return new Proxy({}, { get(_target, key) {
        if (Object.hasOwn(overrides, key)) return overrides[key];
        const value = nativeApi?.[key];
        if (typeof value !== 'function') return value;
        return (...args) => {
          if (!active) return;
          const last = args.length - 1;
          if (typeof args[last] === 'function') args[last] = guard(args[last]);
          return value.apply(nativeApi, args);
        };
      } });
    }

    function sendMessage(message, callback) {
      if (!active) return typeof callback === 'function' ? undefined : Promise.reject(cancellation());
      const boundedAuthTypes = new Set(['get-auth-state', 'refresh-auth-state', 'get-login-roster',
        'manual-student-login', 'request-kiosk-launch', 'validate-kiosk-launch', 'classpilot-request-page-reload']);
      if (!boundedAuthTypes.has(message?.type)) {
        return typeof callback === 'function'
          ? runtime.runtime.sendMessage(message, (...args) => {
            if (active) callback(...args);
            else void runtime.runtime.lastError;
          })
          : runtime.runtime.sendMessage(message);
      }
      const promise = globalThis.ClassPilotAuthGateTransport.sendMessage(message, {
        timeoutMs: 10000, signal: abort.signal, isCurrent: () => active,
        stage: 'message_transport',
      });
      if (typeof callback !== 'function') return promise;
      void promise.then(response => {
        if (active) callback(response);
      }, error => {
        if (active) callback({ success: false, error: 'ClassPilot could not connect. Please try again.',
          errorCode: error?.errorCode || 'AUTH_GATE_RPC_UNAVAILABLE', retryAt: error?.retryAt ?? null });
      });
      return undefined;
    }

    const chrome = api(runtime, {
      runtime: api(runtime.runtime, { sendMessage, onMessage: chromeEvent(runtime.runtime.onMessage) }),
      storage: api(runtime.storage, {
        onChanged: chromeEvent(runtime.storage.onChanged),
        managed: api(runtime.storage.managed), local: api(runtime.storage.local), session: api(runtime.storage.session),
      }),
    });
    const scope = {
      get active() { return active; }, signal: abort.signal, chrome, guard, listen, unlisten, onDispose,
      ownNode(node) {
        if (ownedNodes.has(node)) return node;
        const reference = new WeakRef(node);
        const cleanup = onDispose(() => reference.deref()?.remove(), node);
        ownedNodes.set(node, cleanup);
        return node;
      },
      setTimeout(fn, delay, ...args) {
        if (!active) return null;
        const id = native.setTimeout(() => { timeouts.delete(id); if (active) fn(...args); }, delay);
        timeouts.add(id); return id;
      },
      clearTimeout(id) { native.clearTimeout(id); timeouts.delete(id); },
      setInterval(fn, delay, ...args) {
        if (!active) return null;
        const id = native.setInterval(guard(() => fn(...args)), delay);
        intervals.add(id); return id;
      },
      clearInterval(id) { native.clearInterval(id); intervals.delete(id); },
      requestAnimationFrame(fn) {
        if (!active) return null;
        const id = native.requestAnimationFrame(time => { animationFrames.delete(id); if (active) fn(time); });
        animationFrames.add(id); return id;
      },
      cancelAnimationFrame(id) { native.cancelAnimationFrame(id); animationFrames.delete(id); },
      queueMicrotask(fn) { native.queueMicrotask(guard(fn)); },
      MutationObserver: class {
        constructor(callback) {
          const observer = new native.MutationObserver(guard(callback));
          const observe = observer.observe.bind(observer), disconnect = observer.disconnect.bind(observer);
          const reference = new WeakRef(observer);
          let cleanup = null;
          observer.observe = (...args) => {
            if (!active) return;
            if (!cleanup) cleanup = onDispose(() => reference.deref()?.disconnect(), observer);
            return observe(...args);
          };
          observer.disconnect = () => {
            disconnect();
            if (cleanup) forgetCleanup(cleanup);
            cleanup = null;
          };
          return observer;
        }
      },
      register(nextHooks) { hooks = nextHooks; },
    };
    const controller = {
      protocol: 1, kind, version, instanceId,
      get active() { return active; },
      reconcile() { if (active) hooks.reconcile?.(); },
      inspect() { return { protocol: 1, kind, version, instanceId, active, cleanupCount: cleanups.size, ...hooks.inspect?.() }; },
      dispose() {
        if (!active) return;
        active = false;
        abort.abort();
        try { hooks.dispose?.(); } finally {
          for (const cleanup of cleanups) { try { cleanup(); } catch { /* A disconnected browser context may reject listener removal. */ } }
          for (const cleanup of cleanups) cleanupFinalizer.unregister(cleanup);
          cleanups.clear();
          for (const id of timeouts) native.clearTimeout(id);
          for (const id of intervals) native.clearInterval(id);
          for (const id of animationFrames) native.cancelAnimationFrame(id);
          timeouts.clear(); intervals.clear(); animationFrames.clear();
          if (controllers.get(kind) === controller) {
            controllers.delete(kind);
            if (legacyFlag) delete globalThis[legacyFlag];
            if ((kind === 'content' && globalThis.__classpilotPageReloadProof?.instanceId === instanceId) ||
                (legacyControllerKey && globalThis.__classpilotPageReloadProof?.bootstrap === globalThis[legacyControllerKey])) {
              delete globalThis.__classpilotPageReloadProof;
            }
            if (legacyControllerKey) delete globalThis[legacyControllerKey];
          }
        }
      },
    };
    controllers.set(kind, controller);
    if (legacyFlag) globalThis[legacyFlag] = true;
    return { action: 'created', scope, controller };
  }

  globalThis.ClassPilotPageLifecycle = Object.freeze({
    protocol: 1, begin,
    inspect() { return [...controllers.values()].map(controller => controller.inspect()); },
    reconcile() { controllers.get('bootstrap')?.reconcile(); controllers.get('content')?.reconcile(); },
    dispose() { controllers.get('content')?.dispose(); controllers.get('bootstrap')?.dispose(); },
  });
})();
