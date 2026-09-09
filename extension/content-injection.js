// Worker-only orchestration. Page ownership is checked in the isolated world;
// page-writable IDs, classes and attributes never authorize a reload.
(() => {
  'use strict';

  function inspectPage(action, expectedVersion, expectedProof, deadline) {
    if (Date.now() > deadline) return { status: 'expired' };
    if (window.top !== window || !/^https?:$/.test(location.protocol)) return { status: 'ineligible' };
    const lifecycle = globalThis.ClassPilotPageLifecycle;
    const instances = lifecycle?.protocol === 1 ? lifecycle.inspect() : [];
    const current = instances.filter(item => item.active && item.version === expectedVersion);
    const ready = ['bootstrap', 'content'].every(kind => current.some(item => item.kind === kind));
    const bootstrap = globalThis.__classpilotAuthGateBootstrap;
    const gate = bootstrap?.gateRoot;
    const legacy = instances.length === 0 && globalThis.__CLASSPILOT_AUTH_GATE_BOOTSTRAP_LOADED__ === true;
    const anyLegacyFlag = globalThis.__CLASSPILOT_AUTH_GATE_BOOTSTRAP_LOADED__ === true || globalThis.__CLASSPILOT_CONTENT_LOADED__ === true;
    const modernGate = current.some(item => item.kind === 'content' && item.ownedGate && item.secureFrameOwned);
    const ownedGate = gate instanceof Element && gate.isConnected;
    // After an earlier successful login bootstrap can be inactive while content
    // owns the newly required gate. Modern content exposes its private ownership;
    // legacy takeover stays conservative when bootstrap itself is inactive.
    const proofEligible = ownedGate && (legacy && bootstrap?.active === true || modernGate);
    if (!proofEligible) delete globalThis.__classpilotPageReloadProof;

    if (action === 'reload') {
      const proof = globalThis.__classpilotPageReloadProof;
      if (!proofEligible || !proof || proof.token !== expectedProof || proof.version !== expectedVersion ||
          proof.bootstrap !== bootstrap || proof.gate !== gate || proof.legacy !== legacy ||
          (!legacy && proof.instanceId !== current.find(item => item.kind === 'content')?.instanceId)) {
        return { status: 'manual_reload_required', reason: 'ownership_changed' };
      }
      delete globalThis.__classpilotPageReloadProof;
      location.reload();
      return { status: 'reloaded' };
    }
    if (action === 'reconcile') lifecycle?.reconcile();
    let proofToken = null;
    if (proofEligible) {
      proofToken = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      globalThis.__classpilotPageReloadProof = { token: proofToken, version: expectedVersion,
        bootstrap, gate, legacy, instanceId: current.find(item => item.kind === 'content')?.instanceId };
    }
    // A gate-looking DOM node is negative evidence only. It cannot prove ownership.
    const ambiguousGate = !ownedGate && document.getElementById('classpilot-auth-gate') !== null;
    return { status: ready ? 'ready' : legacy ? 'legacy' : anyLegacyFlag && instances.length === 0 || ambiguousGate ? 'unknown' : 'installable',
      ownedGate: proofEligible, proofToken };
  }

  function create({ chrome, version, files, authorizeReload, isReloadAuthorizationCurrent, timeoutMs = 10000 }) {
    const inFlight = new Map();
    const generations = new Map();
    const pendingMarkerWrites = new Set();
    const boundedTimeout = Math.min(10000, Math.max(1, timeoutMs));
    const markerKey = tabId => `classpilotPageReload:${version}:${tabId}`;
    const manual = reason => ({ status: 'manual_reload_required', reason, version });

    function bounded(promise) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('PAGE_OPERATION_TIMEOUT')), boundedTimeout);
        Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
      });
    }

    async function probe(tabId, documentId, action = 'inspect', proofToken = null) {
      const target = documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] };
      const results = await bounded(chrome.scripting.executeScript({ target, world: 'ISOLATED',
        func: inspectPage, args: [action, version, proofToken, Date.now() + boundedTimeout] }));
      const result = results?.find(item => item.frameId === 0 && typeof item.documentId === 'string');
      if (!result || (documentId && result.documentId !== documentId)) return null;
      return { ...result.result, documentId: result.documentId, version };
    }

    async function guardedReload(tabId, initial, reason, isCurrent) {
      if (!initial?.ownedGate || !initial.proofToken || !initial.documentId) return manual('ownership_unproven');
      const proof = await bounded(authorizeReload({ tabId, documentId: initial.documentId, reason }));
      if (!isCurrent() || !proof) return manual('policy_not_authorized');
      const key = markerKey(tabId);
      const stored = await bounded(chrome.storage.session.get(key));
      if (!isCurrent() || pendingMarkerWrites.has(tabId)) return manual('operation_superseded');
      if (stored?.[key]) return manual('already_attempted');
      // Persist before the action, including failures/navigation, so worker restarts cannot loop.
      pendingMarkerWrites.add(tabId);
      const write = Promise.resolve().then(() => chrome.storage.session.set({ [key]: { version, attempted: true } }));
      void write.then(() => pendingMarkerWrites.delete(tabId), () => pendingMarkerWrites.delete(tabId));
      await bounded(write);
      if (!isCurrent() || isReloadAuthorizationCurrent(proof) !== true) return manual('policy_changed');
      const result = await probe(tabId, initial.documentId, 'reload', initial.proofToken);
      return result?.status === 'reloaded' ? result : manual('document_or_ownership_changed');
    }

    function serialized(tabId, operation) {
      // Reconcile and broadcast callers often race on worker startup. One exact-document
      // transaction wins; failures are never remembered as successful installation.
      if (inFlight.has(tabId)) return inFlight.get(tabId);
      if (pendingMarkerWrites.has(tabId)) return Promise.resolve(manual('marker_write_pending'));
      const generation = generations.get(tabId) || 0;
      const isCurrent = () => (generations.get(tabId) || 0) === generation;
      const promise = Promise.resolve().then(() => operation(isCurrent)).catch(() => manual('page_unavailable')).finally(() => {
        if (inFlight.get(tabId) === promise) inFlight.delete(tabId);
      });
      inFlight.set(tabId, promise);
      return promise;
    }

    return Object.freeze({
      ensure(tabId, { allowLegacyReload = false } = {}) {
        return serialized(tabId, async isCurrent => {
          const initial = await probe(tabId);
          if (!initial || !isCurrent()) return manual('document_unavailable');
          if (initial.status === 'ready') return await probe(tabId, initial.documentId, 'reconcile') || manual('document_changed');
          if (initial.status === 'legacy') return allowLegacyReload
            ? guardedReload(tabId, initial, 'legacy_update', isCurrent) : manual('legacy_requires_update_authorization');
          if (initial.status !== 'installable') return manual('ownership_unproven');
          await bounded(chrome.scripting.executeScript({ target: { tabId, documentIds: [initial.documentId] },
            world: 'ISOLATED', files }));
          if (!isCurrent()) return manual('operation_superseded');
          const installed = await probe(tabId, initial.documentId);
          return installed?.status === 'ready' ? installed : manual('installation_unconfirmed');
        });
      },
      requestReload(sender) {
        if (sender?.id !== chrome.runtime.id || sender?.frameId !== 0 || !Number.isInteger(sender?.tab?.id) ||
            typeof sender.documentId !== 'string') return Promise.resolve(manual('invalid_sender'));
        return serialized(sender.tab.id, async isCurrent => {
          const initial = await probe(sender.tab.id, sender.documentId);
          if (!isCurrent()) return manual('operation_superseded');
          return guardedReload(sender.tab.id, initial, 'explicit_gate_action', isCurrent);
        });
      },
      forgetTab(tabId) { generations.set(tabId, (generations.get(tabId) || 0) + 1); },
    });
  }

  globalThis.ClassPilotContentInjection = Object.freeze({ create });
})();
