import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = process.env.CLASSPILOT_EXTENSION_PATH || fileURLToPath(new URL('../extension/', import.meta.url));
const source = readFileSync(resolve(extensionRoot, 'auth-gate-transport.js'), 'utf8');
function fixture(send = () => {}) {
  let now = 1_000, id = 0;
  const timers = new Map(), diagnostics = [];
  const runtime = { lastError: null, sendMessage: send };
  const context = vm.createContext({
    chrome: { runtime }, AbortController,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { at: now + ms, fn }); return key; },
    clearTimeout(key) { timers.delete(key); },
    ClassPilotAuthRecoveryDiagnostics: { record(event) { diagnostics.push(event); } },
  });
  vm.runInContext(source, context);
  return {
    send: context.ClassPilotAuthGateTransport.sendMessage, runtime, diagnostics, timers,
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await Promise.resolve();
      }
      now = end; await Promise.resolve();
    },
  };
}

test('missing callback settles at ten seconds; late success cannot replace failure', async () => {
  let callback;
  const f = fixture((_message, cb) => { callback = cb; });
  let outcome;
  const pending = f.send({ type: 'get-auth-state' }, { stage: 'frame_state' }).then(value => { outcome = value; }, error => { outcome = error; });
  await f.advance(9999); assert.equal(outcome, undefined);
  await f.advance(1); await pending;
  assert.equal(outcome.code, 'AUTH_GATE_RPC_TIMEOUT');
  callback({ success: true, state: { authRequired: false } });
  await Promise.resolve(); assert.equal(outcome.code, 'AUTH_GATE_RPC_TIMEOUT');
  assert.equal(f.timers.size, 0); assert.equal(f.diagnostics.length, 1);
});

test('synchronous invalidated context is fixed, redacted and immediate', async () => {
  const f = fixture(() => { throw new Error('Extension context invalidated: https://private.invalid?token=secret'); });
  await assert.rejects(f.send({ type: 'get-auth-state', payload: 'private' }), error => error.code === 'AUTH_GATE_CONTEXT_INVALIDATED' && error.message === 'AUTH_GATE_CONTEXT_INVALIDATED');
  assert.equal(f.timers.size, 0);
  assert.equal(JSON.stringify(f.diagnostics).includes('private'), false);
  assert.equal(JSON.stringify(f.diagnostics).includes('secret'), false);
});

test('callback runtime error exposes no raw message', async () => {
  let callback;
  const f = fixture((_message, cb) => { callback = cb; });
  const pending = f.send({ type: 'get-login-roster' });
  f.runtime.lastError = { message: 'Secret response body and student details' };
  callback(undefined);
  await assert.rejects(pending, error => error.code === 'AUTH_GATE_RPC_UNAVAILABLE' && error.message === 'AUTH_GATE_RPC_UNAVAILABLE');
  assert.equal(f.timers.size, 0);
});

test('abort disposes deadline, drops late callback and emits no failure diagnostic', async () => {
  let callback;
  const f = fixture((_message, cb) => { callback = cb; }), controller = new AbortController();
  const pending = f.send({ type: 'get-auth-state' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'AUTH_GATE_REQUEST_CANCELLED');
  callback({ success: true }); await f.advance(20000);
  assert.equal(f.timers.size, 0); assert.equal(f.diagnostics.length, 0);
});

test('request-generation change cannot deliver stale auth proof', async () => {
  let callback, generation = 1;
  const f = fixture((_message, cb) => { callback = cb; });
  const pending = f.send({ type: 'get-auth-state' }, { isCurrent: () => generation === 1 });
  generation = 2; callback({ state: { authRequired: false, revision: 10 } });
  await assert.rejects(pending, error => error.code === 'AUTH_GATE_REQUEST_CANCELLED');
});

test('worker watchdog and pending envelopes reject without carrying supplied auth proof', async () => {
  for (const code of ['AUTH_GATE_POLICY_TIMEOUT','AUTH_GATE_POLICY_UNAVAILABLE','AUTH_GATE_STARTUP_TIMEOUT','AUTH_GATE_RPC_TIMEOUT','AUTH_GATE_LOGIN_PENDING','AUTH_GATE_UNAVAILABLE']) {
    const f = fixture((_message, cb) => cb({ success: false, errorCode: code, retryAt: 5000, state: { authRequired: false }, revision: 99 }));
    await assert.rejects(f.send({ type: 'get-auth-state' }), error => error.code === code && error.retryAt === 5000 && !('state' in error) && !('revision' in error));
  }
});

test('minimal policy-unavailable envelope preserves the worker retry deadline', async () => {
  const f = fixture((_message, cb) => cb({ success: false, errorCode: 'AUTH_GATE_POLICY_UNAVAILABLE', retryAt: 31_000 }));
  await assert.rejects(f.send({ type: 'refresh-auth-state', reason: 'page_timer' }), error => error.code === 'AUTH_GATE_POLICY_UNAVAILABLE' && error.retryAt === 31_000 && error.message === 'AUTH_GATE_POLICY_UNAVAILABLE');
  assert.equal(f.timers.size, 0);
  assert.equal(f.diagnostics.length, 1);
});

test('normal auth rejection remains a response and successful replies release deadline', async () => {
  const denied = { success: false, status: 409, code: 'STUDENT_SESSION_ACTIVE' };
  const f = fixture((_message, cb) => cb(denied));
  assert.equal(await f.send({ type: 'manual-student-login' }), denied);
  assert.equal(f.timers.size, 0); assert.equal(f.diagnostics.length, 0);
});

test('already aborted controller never sends a runtime message', async () => {
  let calls = 0;
  const f = fixture(() => { calls += 1; }), controller = new AbortController(); controller.abort();
  await assert.rejects(f.send({ type: 'manual-student-login' }, { signal: controller.signal }), error => error.code === 'AUTH_GATE_REQUEST_CANCELLED');
  assert.equal(calls, 0);
});
