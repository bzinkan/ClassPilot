import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const modulePath = new URL('../extension/device-telemetry.js', import.meta.url);
let source = '';
try { source = readFileSync(modulePath, 'utf8'); } catch { /* Red before implementation. */ }
const operationId = '11111111-1111-4111-8111-111111111111';
const context = () => ({ studentId: 'student', studentSessionId: 'session', authContextId: 'auth', serverOrigin: 'https://school.invalid', signal: new AbortController().signal });
const identity = (generation = 1) => ({ connectionGeneration: generation, authContextId: 'auth', serverOrigin: 'https://school.invalid' });

function fixture() {
  const sandbox = vm.createContext({ TextEncoder, AbortController, DOMException, setTimeout, clearTimeout });
  vm.runInContext(source, sandbox);
  assert.equal(typeof sandbox.ClassPilotDeviceTelemetry?.createClient, 'function', 'production telemetry client must exist');
  let current = true, available = true, now = 0, serial = 0, sendResult = true;
  const sent = [], timers = new Map();
  const client = sandbox.ClassPilotDeviceTelemetry.createClient({
    send(frame) { sent.push(JSON.parse(frame)); return Promise.resolve(sendResult); },
    isCurrent() { return current; },
    isAvailable() { return available; },
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { client, sent, timers,
    set current(value) { current = value; }, set available(value) { available = value; }, set sendResult(value) { sendResult = value; },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      await Promise.resolve();
    },
  };
}
const request = (options = {}) => ({ operationId, kind: 'heartbeat', studentToken: 'token', payload: { activeTabTitle: 'Lesson' }, context: context(), identity: identity(), ...options });
const result = (options = {}) => ({ type: 'device-telemetry-result', operationId, kind: 'heartbeat', status: 200, body: { ok: true }, exactBinding: { studentId: 'student', studentSessionId: 'session' }, ...options });

test('offscreen acceptance is not a canonical operation receipt', async () => {
  const f = fixture(); let outcome = 'waiting';
  const pending = f.client.request(request()).then(value => { outcome = value; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(outcome, 'waiting'); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, 'device-telemetry');
  assert.equal(f.sent[0].operationId, operationId);
  assert.equal(f.sent[0].payload.telemetryOperationId, operationId);
  assert.equal(f.client.acceptResult(result(), identity()), true);
  await pending;
  assert.equal(outcome.status, 200); assert.equal(outcome.body.ok, true);
  assert.equal(f.timers.size, 0);
});

test('wrong student, operation kind, malformed status and retired connection replies cannot settle work', async () => {
  const f = fixture(); let outcome = 'waiting';
  const pending = f.client.request(request()).then(value => { outcome = value; });
  for (const invalid of [
    result({ exactBinding: { studentId: 'other', studentSessionId: 'session' } }),
    result({ kind: 'screenshot' }), result({ status: '200' }), result({ body: [] }),
  ]) assert.equal(f.client.acceptResult(invalid, identity()), false);
  assert.equal(f.client.acceptResult(result(), identity(2)), false);
  await Promise.resolve(); assert.equal(outcome, 'waiting');
  await f.advance(1500); await pending;
  assert.equal(outcome, null, 'deadline requests HTTP recovery rather than success');
  assert.equal(f.client.acceptResult(result(), identity()), false, 'late result cannot replace HTTP recovery');
});

test('oversize UTF-8 frames and unavailable sockets recover without sending', async () => {
  const f = fixture();
  assert.equal(await f.client.request(request({ payload: { title: '😀'.repeat(70_000) } })), null);
  assert.equal(f.sent.length, 0);
  f.available = false;
  assert.equal(await f.client.request(request()), null);
  assert.equal(f.sent.length, 0);
});

test('aborted or superseded authentication rejects and ignores late receipts', async () => {
  const f = fixture(); const controller = new AbortController();
  const pending = f.client.request(request({ context: { ...context(), signal: controller.signal } }));
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(f.client.acceptResult(result(), identity()), false);
  assert.equal(f.timers.size, 0);
  f.current = false;
  await assert.rejects(f.client.request(request()), error => error.name === 'AbortError');
});

test('socket close releases pending work immediately without resolving a server success', async () => {
  const f = fixture(); const pending = f.client.request(request());
  f.client.cancelConnection(identity());
  assert.equal(await pending, null); assert.equal(f.timers.size, 0);
});

test('one blocked telemetry kind does not block the other kind or admit an unbounded queue', async () => {
  const f = fixture(); const first = f.client.request(request());
  assert.equal(await f.client.request(request({ operationId: '22222222-2222-4222-8222-222222222222' })), null);
  const image = f.client.request(request({ operationId: '33333333-3333-4333-8333-333333333333', kind: 'screenshot' }));
  await Promise.resolve();
  assert.equal(f.sent.length, 2);
  f.client.cancelConnection(identity());
  assert.equal(await first, null); assert.equal(await image, null);
});

test('canonical HTTP denial status is returned intact without transport retry', async () => {
  const f = fixture(); const pending = f.client.request(request());
  await Promise.resolve();
  assert.equal(f.client.acceptResult(result({ status: 401, body: { error: 'Student token expired' } }), identity()), true);
  const outcome = await pending;
  assert.equal(outcome.status, 401); assert.equal(outcome.body.error, 'Student token expired');
  assert.equal(f.sent.length, 1);
});

test('a fresh client after worker restart ignores old receipts', () => {
  assert.equal(fixture().client.acceptResult(result(), identity()), false);
});

test('canceling before the offscreen send task runs never writes the retired operation', async () => {
  const f = fixture(); const controller = new AbortController();
  const pending = f.client.request(request({ signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  await Promise.resolve();
  assert.equal(f.sent.length, 0);
});

test('canonical Retry-After survives the result adapter without forwarding arbitrary headers', async () => {
  const f = fixture(); const pending = f.client.request(request());
  f.client.acceptResult(result({ status: 429, headers: { 'retry-after': '17', 'set-cookie': 'private' } }), identity());
  const outcome = await pending;
  assert.equal(outcome.headers['retry-after'], '17');
  assert.equal(outcome.headers['set-cookie'], undefined);
});
