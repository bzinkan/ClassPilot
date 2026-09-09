import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { resolve } from 'node:path';

const source = readFileSync(process.env.CLASSPILOT_EXTENSION_PATH
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH, 'page-lifecycle.js')
  : new URL('../extension/page-lifecycle.js', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const event = () => {
  const listeners = new Set();
  return { listeners, addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener),
    fire: (...args) => [...listeners].forEach(listener => listener(...args)) };
};
function fixture() {
  let version = '2.8.7';
  const messages = [], pending = [], observers = [], transportCalls = [];
  const onMessage = event(), onChanged = event();
  const context = vm.createContext({ crypto: webcrypto, AbortController, WeakRef, Uint8Array,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    requestAnimationFrame: callback => setTimeout(() => callback(1), 2), cancelAnimationFrame: clearTimeout,
    MutationObserver: class { constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); } observe() { this.disconnected = false; } disconnect() { this.disconnected = true; } },
    chrome: { runtime: { getManifest: () => ({ version }), onMessage,
      sendMessage: (message, callback) => { messages.push(message); if (callback) pending.push(callback); } },
      storage: { onChanged, local: { get: (_keys, callback) => pending.push(callback) }, session: {}, managed: {} } },
    ClassPilotAuthGateTransport: { sendMessage(message, options) {
      transportCalls.push({ message, options });
      return new Promise((resolve, reject) => { pending.push(resolve); options.signal.addEventListener('abort', () => reject({ errorCode: 'AUTH_GATE_REQUEST_CANCELLED' }), { once: true }); });
    } },
  });
  vm.runInContext(source, context);
  return { context, api: context.ClassPilotPageLifecycle, setVersion: value => { version = value; }, messages, pending, observers, onMessage, onChanged, transportCalls };
}

test('same-version reinjection reconciles one owner without registering duplicate listeners', () => {
  const f = fixture(), target = new EventTarget();
  let calls = 0, reconciles = 0;
  const start = f.api.begin('content', { legacyFlag: 'loaded' });
  const listener = () => calls++;
  start.scope.listen(target, 'ping', listener);
  start.scope.listen(target, 'ping', listener);
  start.scope.chrome.runtime.onMessage.addListener(listener);
  start.scope.register({ reconcile: () => reconciles++ });
  for (let i = 0; i < 4; i++) assert.equal(f.api.begin('content', { legacyFlag: 'loaded' }).action, 'existing');
  target.dispatchEvent(new Event('ping')); f.onMessage.fire();
  assert.equal(calls, 2); assert.equal(reconciles, 4); assert.equal(f.onMessage.listeners.size, 1);
  start.controller.dispose(); target.dispatchEvent(new Event('ping')); f.onMessage.fire();
  assert.equal(calls, 2); assert.equal(f.onMessage.listeners.size, 0);
});

test('dispose fences callbacks, observers and microtasks and removes only owned nodes', async () => {
  const f = fixture(), start = f.api.begin('content', { legacyFlag: 'loaded' });
  let callbacks = 0, removed = 0;
  start.scope.ownNode({ remove: () => removed++ });
  start.scope.chrome.storage.local.get([], () => callbacks++);
  start.scope.chrome.runtime.sendMessage({ type: 'raise-hand' }, () => callbacks++);
  start.scope.chrome.runtime.sendMessage({ type: 'get-auth-state' }, () => callbacks++);
  start.scope.queueMicrotask(() => callbacks++);
  start.scope.setTimeout(() => callbacks++, 5);
  start.scope.setInterval(() => callbacks++, 5);
  start.scope.requestAnimationFrame(() => callbacks++);
  new start.scope.MutationObserver(() => callbacks++).observe({});
  start.controller.dispose(); start.controller.dispose();
  f.pending.forEach(callback => callback({ success: true })); f.observers[0].callback();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(callbacks, 0); assert.equal(removed, 1); assert.equal(f.observers[0].disconnected, true);
  assert.equal(f.transportCalls.length, 1); assert.equal(f.transportCalls[0].options.stage, 'message_transport');
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].type, 'raise-hand');
  assert.equal(f.context.loaded, undefined);
});

test('version replacement retires content before bootstrap and legacy owners are never overwritten', () => {
  const f = fixture(), order = [];
  const bootstrap = f.api.begin('bootstrap', { legacyFlag: 'bootstrapLoaded' });
  bootstrap.scope.register({ dispose: () => order.push('bootstrap') });
  const content = f.api.begin('content', { legacyFlag: 'contentLoaded' });
  content.scope.register({ dispose: () => order.push('content') });
  f.setVersion('2.8.8');
  assert.equal(f.api.begin('bootstrap', { legacyFlag: 'bootstrapLoaded' }).action, 'created');
  assert.deepEqual(order, ['content', 'bootstrap']);
  assert.equal(content.controller.active, false);
  const legacy = fixture(); legacy.context.oldLoaded = true;
  assert.equal(legacy.api.begin('content', { legacyFlag: 'oldLoaded' }).action, 'legacy');
  assert.equal(legacy.context.oldLoaded, true); assert.equal(legacy.api.inspect().length, 0);
});

test('removed then re-added capture listener remains singly owned and cancellation cannot settle a retired callback', async () => {
  const f = fixture(), target = new EventTarget(), start = f.api.begin('content');
  let calls = 0;
  const listener = () => calls++;
  start.scope.listen(target, 'ping', listener, true);
  start.scope.unlisten(target, 'ping', listener, true);
  start.scope.listen(target, 'ping', listener, true);
  target.dispatchEvent(new Event('ping'));
  assert.equal(calls, 1);
  start.scope.chrome.runtime.sendMessage({ type: 'get-auth-state' }, () => calls++);
  start.controller.dispose();
  await turn();
  assert.equal(calls, 1);
});

test('repeated listener and observer cycles release registry entries immediately', () => {
  const f = fixture(), target = new EventTarget(), start = f.api.begin('content');
  const baseline = start.controller.inspect().cleanupCount;
  const listener = () => {};
  for (let index = 0; index < 1000; index++) {
    start.scope.listen(target, 'ping', listener);
    start.scope.unlisten(target, 'ping', listener);
    start.scope.listen(target, 'once', listener, { once: true });
    target.dispatchEvent(new Event('once'));
    const observer = new start.scope.MutationObserver(listener);
    observer.observe(target); observer.disconnect();
  }
  assert.equal(start.controller.inspect().cleanupCount, baseline);
  const node = { remove() {} };
  for (let index = 0; index < 1000; index++) start.scope.ownNode(node);
  assert.equal(start.controller.inspect().cleanupCount, baseline + 1);
  start.controller.dispose();
});

test('disposal releases its own reload proof and preserves another owner proof', () => {
  const f = fixture();
  const owner = f.api.begin('content');
  f.context.__classpilotPageReloadProof = { instanceId: owner.controller.instanceId };
  owner.controller.dispose(); assert.equal(f.context.__classpilotPageReloadProof, undefined);
  const bootstrap = f.api.begin('bootstrap', { legacyControllerKey: 'bootstrapController' });
  f.context.bootstrapController = {};
  const otherProof = { bootstrap: {} }; f.context.__classpilotPageReloadProof = otherProof;
  bootstrap.controller.dispose(); assert.equal(f.context.__classpilotPageReloadProof, otherProof);
  const next = f.api.begin('bootstrap', { legacyControllerKey: 'bootstrapController' });
  f.context.bootstrapController = {};
  f.context.__classpilotPageReloadProof = { bootstrap: f.context.bootstrapController };
  next.controller.dispose(); assert.equal(f.context.__classpilotPageReloadProof, undefined);
});
