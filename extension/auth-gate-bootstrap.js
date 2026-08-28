// ClassPilot fast student auth gate
//
// This deliberately small document_start script blocks the first eligible
// page while the service worker restores local authentication state. The
// document_idle content script adopts the same root when it renders the full
// sign-in experience.

(() => {
  'use strict';

  if (globalThis.__CLASSPILOT_AUTH_GATE_BOOTSTRAP_LOADED__) return;
  globalThis.__CLASSPILOT_AUTH_GATE_BOOTSTRAP_LOADED__ = true;

  if (window.top !== window || !/^https?:$/.test(window.location.protocol)) return;

  const startedAt = performance.now();
  const blockedEvents = [
    'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick',
    'contextmenu', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input',
    'wheel', 'touchstart', 'touchmove', 'touchend', 'dragstart', 'drop', 'submit',
  ];

  let active = true;
  let enabled = true;
  let loadingPaintTimer = null;
  let lastState = null;
  let loadingPaintMs = null;
  let recordedAuthGateOutcome = null;
  let interactionBlockersInstalled = false;
  let latestRevision = -1;
  let managedKioskOrigin = null;
  let gateRoot = null;
  let secureFrameFocusTarget = null;
  let stateRequestGeneration = 0;
  let gatePainted = false;
  let gateOwnedByContent = false;
  let integrityObserver = null;
  let integrityReconcileScheduled = false;
  let integrityRecovering = false;
  let integrityDeferredTimer = null;
  let integrityWindowStartedAt = 0;
  let integrityRecoveryCount = 0;
  let integrityRecoverySerial = 0;
  let fullscreenExitPending = false;
  let managedPolicyFenceSerial = 0;
  let pendingManagedPolicyFence = 0;
  let managedPolicyFenceRetryTimer = null;
  const quarantinedElements = new Map();
  const detachedBrowsingContexts = new Map();

  const isExactKioskPage = (state) => (
    (typeof state?.kioskOrigin === 'string' && state.kioskOrigin.length > 0
      ? window.location.origin === state.kioskOrigin
      : managedKioskOrigin !== null && window.location.origin === managedKioskOrigin) &&
    (window.location.pathname === '/passpilot/kiosk' ||
      window.location.pathname.startsWith('/passpilot/kiosk/'))
  );

  const stateRevision = (state) => {
    const revision = Number(state?.revision);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
  };

  const configuredOrigin = (value) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      return new URL(value.trim()).origin;
    } catch (_error) {
      return null;
    }
  };

  const focusGate = () => {
    if (secureFrameFocusTarget?.isConnected) {
      secureFrameFocusTarget.focus({ preventScroll: true });
      return;
    }
    const gate = gateRoot?.isConnected ? gateRoot : null;
    const panel = gate?.querySelector('.classpilot-auth-panel');
    const focusable = gate?.querySelector(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    );
    (focusable || panel)?.focus({ preventScroll: true });
  };

  const blockBehindGate = (event) => {
    if (!active) return;
    const gate = gateRoot?.isConnected ? gateRoot : null;
    // The loading gate has no interactive controls. Consume its events at the
    // earliest window capture listener too, so host-page window listeners
    // cannot observe clicks, keys, wheel, or touch while local auth/config is
    // unresolved. Ready/unavailable gates still need their own controls.
    const loadingPhase = !gate || lastState?.phase === 'loading' || !lastState;
    // Events from the closed-shadow iframe are retargeted to the authentic
    // host. Never authorize arbitrary descendants: the page can mutate light
    // DOM even though it cannot enter the closed shadow tree.
    if (gate && event.target === gate && !loadingPhase) {
      // Closed-shadow iframe events can be retargeted to the host in the
      // embedding document. Preserve their default action for the child frame
      // while preventing later host-page capture listeners from observing the
      // interaction.
      event.stopImmediatePropagation();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'focusin' || (event.type === 'keydown' && event.key === 'Tab')) {
      focusGate();
    }
  };

  const containFocus = (event) => {
    if (!active) return;
    const gate = gateRoot?.isConnected ? gateRoot : null;
    if (gate && event.target === gate) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    focusGate();
  };

  function installInteractionBlockers() {
    if (interactionBlockersInstalled) return;
    for (const eventName of blockedEvents) {
      const options = eventName === 'wheel' || eventName.startsWith('touch')
        ? { capture: true, passive: false }
        : true;
      window.addEventListener(eventName, blockBehindGate, options);
      document.addEventListener(eventName, blockBehindGate, options);
    }
    window.addEventListener('focusin', containFocus, true);
    document.addEventListener('focusin', containFocus, true);
    interactionBlockersInstalled = true;
  }

  function removeInteractionBlockers() {
    if (!interactionBlockersInstalled) return;
    for (const eventName of blockedEvents) {
      window.removeEventListener(eventName, blockBehindGate, true);
      document.removeEventListener(eventName, blockBehindGate, true);
    }
    window.removeEventListener('focusin', containFocus, true);
    document.removeEventListener('focusin', containFocus, true);
    interactionBlockersInstalled = false;
  }

  function quarantinePageSurfaces() {
    const documentRoot = document.documentElement;
    if (!documentRoot) return;

    const quarantineElement = (element) => {
      if (!(element instanceof Element) || element === gateRoot) return;
      if (!quarantinedElements.has(element)) {
        quarantinedElements.set(element, {
          hadInertAttribute: element.hasAttribute('inert'),
          inertAttributeValue: element.getAttribute('inert'),
          pointerEventsValue: element.style?.getPropertyValue('pointer-events') || '',
          pointerEventsPriority: element.style?.getPropertyPriority('pointer-events') || '',
          displayValue: element.style?.getPropertyValue('display') || '',
          displayPriority: element.style?.getPropertyPriority('display') || '',
        });
      }
      if (!element.hasAttribute('inert')) element.setAttribute('inert', '');
      // SVG/MathML do not consistently implement HTMLElement.inert. Disable
      // their entire hit-test subtree too, including foreignObject iframes.
      if (element.style?.getPropertyValue('pointer-events') !== 'none' ||
          element.style?.getPropertyPriority('pointer-events') !== 'important') {
        element.style?.setProperty('pointer-events', 'none', 'important');
      }
      // Inert does not prevent a descendant browsing context from stealing
      // keyboard focus programmatically. Remove every page surface that can
      // render descendants from layout while locked. Preserve <head> itself
      // and its metadata nodes so styles/configuration continue loading.
      const isHeadMetadata = element.parentElement === document.head &&
        ['BASE', 'LINK', 'META', 'NOSCRIPT', 'SCRIPT', 'STYLE', 'TEMPLATE', 'TITLE']
          .includes(element.tagName);
      if (element !== document.head && !isHeadMetadata &&
          (element.style?.getPropertyValue('display') !== 'none' ||
           element.style?.getPropertyPriority('display') !== 'important')) {
        element.style?.setProperty('display', 'none', 'important');
      }
    };

    // The authentic gate is a direct child of <html>. Quarantine every other
    // direct document surface, plus body children for deterministic protection
    // against frames inserted before document_idle adopts the secure gate.
    for (const element of Array.from(documentRoot.children)) {
      if (element === gateRoot) continue;
      quarantineElement(element);
    }
    for (const element of Array.from(document.body?.children || [])) {
      if (element === gateRoot) continue;
      quarantineElement(element);
    }
    for (const element of Array.from(document.head?.querySelectorAll('*') || [])) {
      quarantineElement(element);
    }
    detachPageBrowsingContexts();

    if (gateRoot?.isConnected) {
      if (gateRoot.parentElement !== documentRoot ||
          documentRoot.lastElementChild !== gateRoot) {
        documentRoot.appendChild(gateRoot);
      }
    }

    // Dialogs, popovers, and fullscreen elements render in a top layer above
    // any z-index. Remove page-owned surfaces from that layer while auth is
    // unresolved; their normal state is available again after release.
    for (const dialog of document.querySelectorAll('dialog[open]')) {
      try { dialog.close(); } catch (_error) { /* already closing */ }
    }
    for (const popover of document.querySelectorAll('[popover]')) {
      try {
        if (popover.matches(':popover-open')) popover.hidePopover();
      } catch (_error) {
        // Older Chromium builds may not expose the popover pseudo-class.
      }
    }
    if (document.fullscreenElement && !fullscreenExitPending) {
      fullscreenExitPending = true;
      Promise.resolve(document.exitFullscreen?.())
        .catch(() => {})
        .finally(() => {
          fullscreenExitPending = false;
        });
    }
    if (gateRoot?.isConnected && document.activeElement !== gateRoot &&
        !gateRoot.contains(document.activeElement)) {
      focusGate();
    }
  }

  function detachPageBrowsingContexts() {
    for (const contextElement of document.querySelectorAll('iframe, frame, object, embed')) {
      if (!detachedBrowsingContexts.has(contextElement)) {
        detachedBrowsingContexts.set(contextElement, {
          parent: contextElement.parentNode,
          nextSibling: contextElement.nextSibling,
        });
      }
      contextElement.remove();
    }
  }

  function restoreDetachedBrowsingContexts() {
    for (const [contextElement, placement] of detachedBrowsingContexts) {
      if (contextElement.isConnected || !placement.parent) continue;
      const anchor = placement.nextSibling?.parentNode === placement.parent
        ? placement.nextSibling
        : null;
      try {
        placement.parent.insertBefore(contextElement, anchor);
      } catch (_error) {
        // The page retired this parent while locked; do not guess a new home.
      }
    }
    detachedBrowsingContexts.clear();
  }

  function restoreQuarantinedElement(element) {
    const original = quarantinedElements.get(element);
    if (!original) return;
    if (original.hadInertAttribute) {
      element.setAttribute('inert', original.inertAttributeValue ?? '');
    } else {
      element.removeAttribute('inert');
    }
    if (element.style) {
      if (original.pointerEventsValue) {
        element.style.setProperty(
          'pointer-events',
          original.pointerEventsValue,
          original.pointerEventsPriority
        );
      } else {
        element.style.removeProperty('pointer-events');
      }
      if (original.displayValue) {
        element.style.setProperty(
          'display',
          original.displayValue,
          original.displayPriority
        );
      } else {
        element.style.removeProperty('display');
      }
    }
    quarantinedElements.delete(element);
  }

  function isGateMountedOnCurrentRoot() {
    return Boolean(
      gateRoot?.isConnected &&
      gateRoot.parentElement === document.documentElement
    );
  }

  function scheduleIntegrityReconcile() {
    if (!active || !enabled || integrityReconcileScheduled) return;
    integrityReconcileScheduled = true;
    queueMicrotask(() => {
      integrityReconcileScheduled = false;
      reconcileGateIntegrity();
    });
  }

  function reconcileGateIntegrity() {
    if (!active || !enabled || integrityRecovering) return;
    quarantinePageSurfaces();
    if (!gatePainted || isGateMountedOnCurrentRoot()) return;

    const now = performance.now();
    if (now - integrityWindowStartedAt > 250) {
      integrityWindowStartedAt = now;
      integrityRecoveryCount = 0;
    }
    if (integrityRecoveryCount >= 4) {
      if (integrityDeferredTimer === null) {
        integrityDeferredTimer = setTimeout(() => {
          integrityDeferredTimer = null;
          reconcileGateIntegrity();
        }, 50);
      }
      return;
    }
    integrityRecoveryCount += 1;
    recoverGateIntegrity();
  }

  function recoverGateIntegrity() {
    if (!active || !enabled || integrityRecovering) return;
    integrityRecovering = true;
    try {
      gateRoot?.remove();
      gateRoot = null;
      secureFrameFocusTarget = null;
      gateOwnedByContent = false;
      paintConnectingGate({
        ...(lastState || {}),
        phase: 'loading',
        authRequired: true,
      });
      if (gateRoot) {
        integrityRecoverySerial += 1;
        gateRoot.dataset.classpilotAuthRecovery = 'restored';
        gateRoot.dataset.classpilotAuthRecoverySerial = String(integrityRecoverySerial);
      }
      quarantinePageSurfaces();
    } finally {
      integrityRecovering = false;
    }
  }

  function preventPagePopoverWhileLocked(event) {
    if (!active || event.target === gateRoot) return;
    if (event.newState === 'open' && event.cancelable) event.preventDefault();
    scheduleIntegrityReconcile();
  }

  function startIntegrityWatchdog() {
    quarantinePageSurfaces();
    if (integrityObserver) return;
    integrityObserver = new MutationObserver(scheduleIntegrityReconcile);
    // Observe Document rather than the current <html> node so replacing the
    // entire documentElement cannot detach the watchdog with the trusted gate.
    integrityObserver.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['inert', 'open', 'style'],
    });
    document.addEventListener('fullscreenchange', scheduleIntegrityReconcile, true);
    document.addEventListener('toggle', scheduleIntegrityReconcile, true);
    document.addEventListener('beforetoggle', preventPagePopoverWhileLocked, true);
  }

  function stopIntegrityWatchdog() {
    integrityObserver?.disconnect();
    integrityObserver = null;
    document.removeEventListener('fullscreenchange', scheduleIntegrityReconcile, true);
    document.removeEventListener('toggle', scheduleIntegrityReconcile, true);
    document.removeEventListener('beforetoggle', preventPagePopoverWhileLocked, true);
    integrityReconcileScheduled = false;
    integrityRecovering = false;
    if (integrityDeferredTimer !== null) {
      clearTimeout(integrityDeferredTimer);
      integrityDeferredTimer = null;
    }
    integrityWindowStartedAt = 0;
    integrityRecoveryCount = 0;
    fullscreenExitPending = false;
    restoreDetachedBrowsingContexts();
    for (const element of Array.from(quarantinedElements.keys())) {
      restoreQuarantinedElement(element);
    }
  }

  installInteractionBlockers();
  startIntegrityWatchdog();

  const controller = {
    get active() {
      return active;
    },
    get enabled() {
      return enabled;
    },
    get lastState() {
      return lastState;
    },
    get gateRoot() {
      return gateRoot?.isConnected ? gateRoot : null;
    },
    get managedPolicyFencePending() {
      return pendingManagedPolicyFence > 0;
    },
    get managedPolicyFence() {
      return pendingManagedPolicyFence;
    },
    release,
    showLoading: paintConnectingGate,
    recordOutcome,
    engage,
    beginManagedPolicyFence,
    adoptSecureGate(gate, state) {
      if (!(gate instanceof Element) || gate.id !== 'classpilot-auth-gate') return;
      gateRoot = gate;
      restoreQuarantinedElement(gate);
      gateRoot.setAttribute('tabindex', '-1');
      gatePainted = true;
      gateOwnedByContent = true;
      if (state && typeof state === 'object') lastState = state;
      quarantinePageSurfaces();
      scheduleIntegrityReconcile();
    },
    setSecureFrameFocusTarget(frame) {
      secureFrameFocusTarget = frame?.isConnected ? frame : null;
    },
  };
  globalThis.__classpilotAuthGateBootstrap = controller;

  function recordLoadingPaint() {
    if (loadingPaintMs !== null) return;
    loadingPaintMs = Math.max(0, Math.round(performance.now() - startedAt));
    const diagnostic = {
      loadingPaintMs,
      configReadyMs: null,
      outcome: 'loading',
      coldWorker: false,
      timestamp: Date.now(),
    };
    chrome.runtime.sendMessage({ type: 'record-auth-gate-timing', timing: diagnostic }, () => {
      void chrome.runtime.lastError;
    });
  }

  function recordOutcome(state = {}) {
    const phase = typeof state.phase === 'string'
      ? state.phase
      : state.authRequired === false
        ? 'authenticated'
        : state.setupRequired === true
          ? 'setup_required'
          : 'ready';
    const candidate = {
      loadingPaintMs,
      configReadyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      outcome: phase,
      coldWorker: state.coldWorker === true,
      timestamp: Date.now(),
    };
    // document_start and document_idle can both request the same restored
    // state. The later warm duplicate must not overwrite the cold worker's
    // first decision or its SLA timing for the same outcome.
    if (!(
      recordedAuthGateOutcome?.outcome === candidate.outcome
      && recordedAuthGateOutcome.coldWorker === true
      && candidate.coldWorker === false
    )) {
      recordedAuthGateOutcome = candidate;
    }
    chrome.runtime.sendMessage({
      type: 'record-auth-gate-timing',
      timing: recordedAuthGateOutcome,
    }, () => {
      void chrome.runtime.lastError;
    });
  }

  function paintConnectingGate(state = {}) {
    if (!active || !enabled || isExactKioskPage(state)) return;

    lastState = state;
    document.documentElement.classList.add('classpilot-auth-locked');
    document.body?.classList.add('classpilot-auth-locked');

    let gate = gateRoot?.isConnected ? gateRoot : null;
    if (gate && gateOwnedByContent) return;

    if (!gate) {
      gate = document.createElement('div');
      gate.id = 'classpilot-auth-gate';
      document.documentElement.appendChild(gate);
    } else if (gate.parentElement !== document.documentElement) {
      document.documentElement.appendChild(gate);
    }
    gateRoot = gate;
    restoreQuarantinedElement(gate);
    gateRoot.setAttribute('tabindex', '-1');
    gatePainted = true;
    gateOwnedByContent = false;

    gate.dataset.classpilotAuthBootstrap = 'true';
    gate.dataset.classpilotAuthBlocker = 'bootstrap';
    if (gate.dataset.classpilotAuthContainmentInstalled !== 'true') {
      gate.dataset.classpilotAuthContainmentInstalled = 'true';
      for (const eventName of blockedEvents) {
        gate.addEventListener(eventName, (event) => event.stopPropagation());
      }
    }
    gate.innerHTML = `
      <style>
        html.classpilot-auth-locked,
        body.classpilot-auth-locked {
          overflow: hidden !important;
        }
        #classpilot-auth-gate {
          position: fixed !important;
          inset: 0 !important;
          z-index: 2147483647 !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          width: 100vw !important;
          height: 100vh !important;
          height: 100dvh !important;
          padding: 24px !important;
          overflow: auto !important;
          overscroll-behavior: contain !important;
          background: linear-gradient(180deg, rgba(14, 42, 87, 0.94), rgba(25, 55, 100, 0.88)) !important;
          backdrop-filter: blur(12px) !important;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
          color: #0e2a57 !important;
          box-sizing: border-box !important;
        }
        #classpilot-auth-gate * {
          box-sizing: border-box !important;
        }
        #classpilot-auth-gate .classpilot-auth-panel {
          width: min(760px, 100%) !important;
          min-height: 350px !important;
          padding: 48px !important;
          border: 1px solid rgba(216, 222, 232, 0.8) !important;
          border-radius: 28px !important;
          background: #ffffff !important;
          box-shadow: 0 25px 70px rgba(15, 23, 42, 0.35) !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          text-align: center !important;
          outline: none !important;
        }
        #classpilot-auth-gate .classpilot-auth-loading-content {
          width: min(480px, 100%) !important;
        }
        #classpilot-auth-gate .classpilot-auth-product {
          display: inline-flex !important;
          align-items: center !important;
          gap: 12px !important;
          margin-bottom: 28px !important;
          color: #0e2a57 !important;
          font-size: 20px !important;
          font-weight: 800 !important;
        }
        #classpilot-auth-gate .classpilot-auth-logo {
          width: 44px !important;
          height: 44px !important;
          border-radius: 12px !important;
          background: #0e2a57 !important;
          color: #f5b81f !important;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
        }
        #classpilot-auth-gate .classpilot-auth-logo svg {
          width: 24px !important;
          height: 24px !important;
          stroke: currentColor !important;
        }
        #classpilot-auth-gate h1 {
          margin: 0 !important;
          color: #0e2a57 !important;
          font-size: clamp(30px, 5vw, 42px) !important;
          line-height: 1.08 !important;
          font-weight: 800 !important;
        }
        #classpilot-auth-gate p {
          margin: 14px auto 0 !important;
          color: #6b7a90 !important;
          font-size: 17px !important;
          line-height: 1.55 !important;
        }
        #classpilot-auth-gate .classpilot-auth-spinner {
          width: 36px !important;
          height: 36px !important;
          margin: 30px auto 0 !important;
          border: 4px solid #e2e8f0 !important;
          border-top-color: #f5b81f !important;
          border-radius: 999px !important;
          animation: classpilot-auth-spin 0.9s linear infinite !important;
        }
        @keyframes classpilot-auth-spin {
          to { transform: rotate(360deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          #classpilot-auth-gate .classpilot-auth-spinner {
            animation-duration: 1.8s !important;
          }
        }
        @media (max-width: 640px), (max-height: 480px) {
          #classpilot-auth-gate {
            padding: 8px !important;
          }
          #classpilot-auth-gate .classpilot-auth-panel {
            min-height: min(320px, calc(100dvh - 16px)) !important;
            padding: 28px 20px !important;
            border-radius: 18px !important;
          }
        }
      </style>
      <div class="classpilot-auth-panel" role="dialog" aria-modal="true" aria-labelledby="classpilot-auth-title" aria-describedby="classpilot-auth-subtitle" aria-busy="true" tabindex="-1">
        <div class="classpilot-auth-loading-content">
          <div class="classpilot-auth-product">
            <span class="classpilot-auth-logo" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path></svg>
            </span>
            <span>ClassPilot</span>
          </div>
          <h1 id="classpilot-auth-title">Connecting to ClassPilot…</h1>
          <p id="classpilot-auth-subtitle">Checking your school’s sign-in settings. Browsing will stay locked until ClassPilot is ready.</p>
          <div class="classpilot-auth-spinner" aria-hidden="true"></div>
        </div>
      </div>
    `;

    quarantinePageSurfaces();
    recordLoadingPaint();
    requestAnimationFrame(() => {
      if (active && gate?.isConnected) {
        gate.querySelector('.classpilot-auth-panel')?.focus({ preventScroll: true });
      }
    });
  }

  function release(options = {}) {
    if (!active) return;
    // Once document_idle has adopted the host, content.js owns the matching
    // quarantine snapshot and must unwind it before this document_start layer
    // restores its earlier snapshot. The two managed-policy revalidation
    // requests can resolve in either order; allowing the bootstrap callback to
    // release first would make content.js later restore bootstrap's temporary
    // inert/display values as though they belonged to the page. Stay locked
    // until the adopting controller explicitly performs the ordered release.
    if (gateOwnedByContent && options.fromContent !== true) return;
    const gate = gateRoot;
    active = false;
    secureFrameFocusTarget = null;
    gateOwnedByContent = false;
    pendingManagedPolicyFence = 0;
    stateRequestGeneration += 1;
    if (managedPolicyFenceRetryTimer !== null) {
      clearTimeout(managedPolicyFenceRetryTimer);
      managedPolicyFenceRetryTimer = null;
    }
    if (loadingPaintTimer !== null) {
      clearTimeout(loadingPaintTimer);
      loadingPaintTimer = null;
    }
    stopIntegrityWatchdog();
    removeInteractionBlockers();
    if (options.keepGate !== true) gate?.remove();
    gateRoot = null;
    document.documentElement.classList.remove('classpilot-auth-locked');
    document.body?.classList.remove('classpilot-auth-locked');
  }

  function requestLocalAuthState() {
    const requestGeneration = ++stateRequestGeneration;
    chrome.runtime.sendMessage({ type: 'get-auth-state' }, (response) => {
      if (!active || !enabled || pendingManagedPolicyFence > 0 ||
          requestGeneration !== stateRequestGeneration) return;
      if (chrome.runtime.lastError || !response?.success || !response.state) {
        paintConnectingGate({ phase: 'loading', authRequired: true });
        return;
      }
      applyAuthState(response.state);
    });
  }

  function nextManagedPolicyFence() {
    managedPolicyFenceSerial = managedPolicyFenceSerial >= Number.MAX_SAFE_INTEGER
      ? 1
      : managedPolicyFenceSerial + 1;
    return managedPolicyFenceSerial;
  }

  function scheduleManagedPolicyFenceRetry(fence) {
    if (!active || pendingManagedPolicyFence !== fence || managedPolicyFenceRetryTimer !== null) return;
    managedPolicyFenceRetryTimer = setTimeout(() => {
      managedPolicyFenceRetryTimer = null;
      requestManagedPolicyRevalidation(fence);
    }, 250);
  }

  function requestManagedPolicyRevalidation(fence) {
    if (!active || pendingManagedPolicyFence !== fence) return;
    chrome.runtime.sendMessage({
      type: 'get-auth-state',
      revalidateManagedPolicy: true,
      managedPolicyFence: fence,
    }, (response) => {
      if (!active || pendingManagedPolicyFence !== fence) return;
      const responseRevision = stateRevision(response?.state);
      const workerGeneration = Number(response?.managedPolicyGeneration);
      const validFenceAck = !chrome.runtime.lastError && response?.success === true &&
        response?.managedPolicyFence === fence &&
        Number.isSafeInteger(workerGeneration) && workerGeneration >= 0 &&
        responseRevision !== null && responseRevision >= latestRevision;
      if (!validFenceAck) {
        paintConnectingGate({
          phase: 'loading',
          authRequired: true,
          revision: latestRevision >= 0 ? latestRevision : undefined,
        });
        scheduleManagedPolicyFenceRetry(fence);
        return;
      }

      pendingManagedPolicyFence = 0;
      if (managedPolicyFenceRetryTimer !== null) {
        clearTimeout(managedPolicyFenceRetryTimer);
        managedPolicyFenceRetryTimer = null;
      }
      enabled = response.state.fastAuthGateEnabled !== false;
      managedKioskOrigin = configuredOrigin(response.state.kioskOrigin);
      if (!enabled) {
        recordOutcome(response.state);
        release();
        return;
      }
      applyAuthState(response.state, { managedPolicyFenceValidated: true });
    });
  }

  function beginManagedPolicyFence() {
    const fence = nextManagedPolicyFence();
    pendingManagedPolicyFence = fence;
    stateRequestGeneration += 1;
    if (managedPolicyFenceRetryTimer !== null) {
      clearTimeout(managedPolicyFenceRetryTimer);
      managedPolicyFenceRetryTimer = null;
    }
    // Treat all changed managed values as untrusted hints until the worker has
    // reread the complete local policy under its generation barrier.
    enabled = true;
    if (!active) active = true;
    installInteractionBlockers();
    startIntegrityWatchdog();
    paintConnectingGate({
      phase: 'loading',
      authRequired: true,
      revision: latestRevision >= 0 ? latestRevision : undefined,
    });
    requestManagedPolicyRevalidation(fence);
  }

  function engage() {
    if (!enabled) return;
    if (!active) active = true;
    installInteractionBlockers();
    startIntegrityWatchdog();
    if (loadingPaintTimer !== null) clearTimeout(loadingPaintTimer);
    loadingPaintTimer = setTimeout(() => {
      paintConnectingGate({ phase: 'loading', authRequired: true });
    }, 250);
    requestLocalAuthState();
  }

  function applyAuthState(state, options = {}) {
    if (!active || !enabled) return;
    if (pendingManagedPolicyFence > 0 && options.managedPolicyFenceValidated !== true) return;
    lastState = state && typeof state === 'object' ? state : null;
    const revision = stateRevision(lastState);
    if (revision !== null && revision < latestRevision) return;
    if (revision !== null) latestRevision = Math.max(latestRevision, revision);
    const phase = lastState?.phase;
    if (phase === 'authenticated' || lastState?.authRequired === false || isExactKioskPage(lastState)) {
      recordOutcome({ ...lastState, phase: phase === 'authenticated' ? phase : 'authenticated' });
      release();
      return;
    }
    if (phase === 'ready' || phase === 'setup_required' || phase === 'unavailable') {
      recordOutcome(lastState);
    }
    paintConnectingGate(lastState || { phase: 'loading', authRequired: true });
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender?.id && sender.id !== chrome.runtime.id) return;
    if (message?.type === 'CLASSPILOT_AUTH_COMPLETE') {
      applyAuthState({ ...(message.state || {}), phase: 'authenticated', authRequired: false });
    } else if (message?.type === 'CLASSPILOT_AUTH_REQUIRED') {
      applyAuthState(message.state);
    }
  });

  // Fail closed if a cold worker needs longer than the normal local-only check.
  // Authenticated profiles that answer promptly never see a painted gate.
  loadingPaintTimer = setTimeout(() => paintConnectingGate({ phase: 'loading', authRequired: true }), 250);

  const initialManagedPolicyReadGeneration = stateRequestGeneration;
  chrome.storage.managed.get(['fastAuthGateEnabled', 'serverUrl'], (policy) => {
    if (pendingManagedPolicyFence > 0 ||
        initialManagedPolicyReadGeneration !== stateRequestGeneration) return;
    const storageError = chrome.runtime.lastError;
    enabled = storageError ? true : policy?.fastAuthGateEnabled !== false;
    if (!enabled) {
      release();
      return;
    }

    managedKioskOrigin = configuredOrigin(policy?.serverUrl);
    if (isExactKioskPage(null)) {
      release();
      return;
    }

    requestLocalAuthState();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'managed') return;
    const relevantChange = [
      'fastAuthGateEnabled',
      'serverUrl',
      'classpilotServerUrl',
      'schoolSlug',
      'classpilotSchoolSlug',
      'schoolId',
      'classpilotSchoolId',
      'enrollmentKey',
      'classpilotEnrollmentKey',
    ].some((key) => Object.prototype.hasOwnProperty.call(changes, key));
    if (!relevantChange) return;
    // Keep the prior revision as a floor. Changed storage values and queued
    // pushes are not authoritative until the worker acknowledges a fresh,
    // local-only managed-policy reread for this exact client fence.
    beginManagedPolicyFence();
  });
})();
