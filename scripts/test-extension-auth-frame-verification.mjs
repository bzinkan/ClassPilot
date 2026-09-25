import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = readFileSync(process.env.CLASSPILOT_EXTENSION_PATH
  ? join(process.env.CLASSPILOT_EXTENSION_PATH, 'content.js')
  : new URL('../extension/content.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function functionSource(name) {
  const match = new RegExp(`^function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `Missing production function ${name}`);
  const rest = source.slice(match.index + match[0].length);
  const end = /^}/m.exec(rest);
  assert.ok(end, `Missing production function boundary ${name}`);
  return source.slice(match.index, match.index + match[0].length + end.index + 1);
}
const messageStart = source.indexOf("lifecycle.listen(window, 'message', (event) => {");
const messageEnd = source.indexOf('\n}, true);', messageStart);
assert.ok(messageStart >= 0 && messageEnd > messageStart);
const messageSource = source.slice(messageStart, messageEnd + '\n}, true);'.length);

function harness({ pendingPolicy = true, reloadWithoutHandshake = false } = {}) {
  let now = 0, timerSerial = 0;
  const timers = new Map(), diagnostics = [], navigations = [], messages = [];
  const classes = new Set(), attrs = {};
  const frameWindow = { postMessage(message) { messages.push(message); } };
  const frame = { isConnected: true, contentWindow: frameWindow,
    classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); } }, focus() {} };
  const gate = { isConnected: true, dataset: {}, setAttribute(key, value) { attrs[key] = value; } };
  const bootstrap = { managedPolicyFencePending: pendingPolicy, adoptSecureGate() {}, setSecureFrameFocusTarget() {} };
  const context = vm.createContext({
    console, crypto: webcrypto, URL,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { const id = ++timerSerial; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    window: {}, lifecycle: { listen(_target, _type, handler) { context.onMessage = handler; } },
    chrome: { runtime: { getURL: path => `chrome-extension://fixture/${path}`, sendMessage() {} } },
    ClassPilotAuthRecoveryDiagnostics: { record(value) { diagnostics.push({ ...value, at: now }); } },
    __classpilotAuthGateBootstrap: bootstrap,
    authGateActive: true, authGateSecureFrame: frame, authGateTrustedRoot: gate,
    authGateSecureFallback: { hidden: false, textContent: '' }, authGateSecureFrameNonce: 'a'.repeat(64),
    authGateSecureFrameVerifiedNonce: '', authGateSecureFrameReady: false, authGateSecureFrameTrusted: false,
    authGateSecureFramePendingPhase: 'loading', authGateTrustedPhase: 'loading',
    authGateSecureFrameRecoveryTimer: null, authGateSecureFrameDeadlineTimer: null,
    authGateSecureFrameRecoveryStartedAt: 0, authGateSecureFrameRecoveryAttempts: 0,
    authGateSecureFrameFailed: false, authGateCurrentState: { phase: 'loading', authRequired: true },
    authGatePendingManagedPolicyFence: pendingPolicy ? 1 : 0, authGateManagedPolicyFailure: null,
    AUTH_GATE_FRAME_ORIGIN: 'chrome-extension://fixture',
    AUTH_GATE_PHASES: new Set(['authenticated', 'loading', 'ready', 'setup_required', 'unavailable']),
    reconcileAuthGatePresenceSignal() {}, recordAuthGateOutcome() {},
    removeAuthGate() { context.released = true; }, released: false,
  });
  for (const name of ['authGatePhase', 'isAuthGateManagedPolicyFencePending', 'notifyAuthGatePolicyRecovery',
    'createAuthGateFrameNonce', 'secureAuthGateFrameUrl', 'clearSecureAuthGateFrameRecovery',
    'startSecureAuthGateFrameRecoveryWindow', 'paintSecureAuthGateFrameFailure',
    'clearSecureAuthGateFrameRecoveryWindow', 'markSecureAuthGateFrameUntrusted',
    'beginSecureAuthGateFrameVerification', 'resetSecureAuthGateFrame', 'applyTrustedAuthGateFramePhase']) {
    vm.runInContext(functionSource(name), context, { filename: `production:${name}` });
  }
  vm.runInContext(messageSource, context, { filename: 'production:frame-message-handler' });
  Object.defineProperty(frame, 'src', { set(value) {
    navigations.push({ value, at: now });
    if (reloadWithoutHandshake) context.setTimeout(() => context.beginSecureAuthGateFrameVerification(), 0);
  } });
  const send = (type, values = {}, overrides = {}) => context.onMessage({
    isTrusted: true, source: frameWindow, origin: context.AUTH_GATE_FRAME_ORIGIN,
    data: { type, nonce: context.authGateSecureFrameNonce, ...values }, ...overrides,
  });
  return { context, timers, diagnostics, navigations, messages, classes, attrs, bootstrap, frame,
    start() { context.startSecureAuthGateFrameRecoveryWindow(); context.beginSecureAuthGateFrameVerification(); },
    send,
    handshake() { send('CLASSPILOT_AUTH_FRAME_PHASE', { phase: 'loading' }); send('CLASSPILOT_AUTH_FRAME_READY'); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      now = end;
    },
  };
}

test('a verified frame may await policy beyond the script deadline without granting authentication', () => {
  const h = harness(); h.start(); h.handshake();
  const firstNonce = h.context.authGateSecureFrameNonce;
  h.send('CLASSPILOT_AUTH_FRAME_PHASE', { phase: 'authenticated' });
  h.advance(11_000);
  assert.equal(h.context.authGateSecureFrameFailed, false,
    '[regression:frame-policy-wait] a responsive nonce-bound document must not expire while policy is pending');
  assert.equal(h.navigations.length, 0, 'a valid document must not enter the 300ms script reload loop');
  assert.equal(h.context.authGateSecureFrameNonce, firstNonce);
  assert.equal(h.context.authGateSecureFrameTrusted, false);
  assert.equal(h.context.released, false, 'document verification cannot authorize release under a pending policy fence');
  assert.equal(h.classes.has('classpilot-auth-frame-loaded'), false);
  assert.equal(h.diagnostics.length, 0);

  // The current policy acknowledgement retires the failure-only document.
  // Its replacement must prove a new nonce before presenting credentials.
  h.context.authGatePendingManagedPolicyFence = 0; h.bootstrap.managedPolicyFencePending = false;
  h.context.resetSecureAuthGateFrame();
  assert.notEqual(h.context.authGateSecureFrameNonce, firstNonce);
  assert.equal(h.context.authGateSecureFrameTrusted, false);
  h.context.beginSecureAuthGateFrameVerification(); h.handshake();
  h.send('CLASSPILOT_AUTH_FRAME_PHASE', { phase: 'ready' });
  assert.equal(h.context.authGateSecureFrameTrusted, true);
  assert.equal(h.context.authGateTrustedPhase, 'ready');
  assert.equal(h.context.released, false);
});

test('missing frame handshakes still exhaust one bounded script-recovery budget', () => {
  const h = harness({ reloadWithoutHandshake: true }); h.start();
  h.advance(10_000);
  assert.equal(h.context.authGateSecureFrameFailed, true);
  assert.equal(h.attrs['data-classpilot-auth-frame-status'], 'unavailable');
  assert.equal(h.diagnostics.length, 1);
  assert.equal(h.diagnostics[0].stage, 'script_recovery');
  assert.equal(h.diagnostics[0].elapsedMs, 10_000);
  assert.ok(h.navigations.length >= 20 && h.navigations.length <= 34, 'reloads cannot extend the original ten-second budget');
  const navigations = h.navigations.length;
  h.advance(20_000);
  assert.equal(h.navigations.length, navigations);
  assert.equal(h.context.released, false);
});

test('wrong nonce, origin, source and untrusted READY cannot end frame verification', () => {
  for (const rejection of ['nonce', 'origin', 'source', 'untrusted']) {
    const h = harness(); h.start();
    h.send('CLASSPILOT_AUTH_FRAME_READY', rejection === 'nonce' ? { nonce: 'b'.repeat(64) } : {},
      rejection === 'origin' ? { origin: 'https://hostile.invalid' }
        : rejection === 'source' ? { source: {} } : rejection === 'untrusted' ? { isTrusted: false } : {});
    h.advance(10_000);
    assert.equal(h.context.authGateSecureFrameFailed, true, rejection);
    assert.equal(h.context.released, false, rejection);
  }
});

test('a replacement document cannot inherit an old nonce or handshake deadline exemption', () => {
  const h = harness(); h.start(); h.handshake();
  const oldNonce = h.context.authGateSecureFrameNonce;
  h.advance(11_000); h.context.resetSecureAuthGateFrame(); h.context.beginSecureAuthGateFrameVerification();
  h.send('CLASSPILOT_AUTH_FRAME_READY', { nonce: oldNonce });
  h.advance(10_000);
  assert.equal(h.context.authGateSecureFrameFailed, true);
  assert.equal(h.context.released, false);
  assert.equal(h.diagnostics.at(-1).elapsedMs, 10_000);
});

test('a frame leaving after verification requires a new bounded handshake', () => {
  const h = harness(); h.start(); h.handshake();
  h.send('CLASSPILOT_AUTH_FRAME_LEAVING'); h.advance(10_000);
  assert.equal(h.context.authGateSecureFrameFailed, true);
  assert.equal(h.context.released, false);
});

test('a late READY cannot revive a document whose script-recovery budget already failed', () => {
  const h = harness(); h.start(); h.advance(10_000);
  h.send('CLASSPILOT_AUTH_FRAME_READY');
  h.send('CLASSPILOT_AUTH_FRAME_PHASE', { phase: 'ready' });
  assert.equal(h.context.authGateSecureFrameFailed, true);
  assert.equal(h.context.authGateSecureFrameTrusted, false);
  assert.equal(h.context.released, false);
});
