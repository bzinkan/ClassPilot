import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createServer } from 'node:http';
await import('../extension/windows-browser-channel.js');
const { create, deadline, route } = globalThis.ClassPilotWindowsChannel;
function fixture({ family = 'chrome', responseFamily = family, guardTtl = 45, holdPair = false, real = false, fetchOverride, initialOrigin } = {}) {
  let clock = 100, messages = [], disconnects = [], pendingPair;
  let serverOrigin=initialOrigin || 'https://synthetic.example';
  const calls = [], invalidations = [], adopted = [], frames = [], stored = {};
  const epoch = randomUUID(), sourceRef = randomUUID();
  const baseTime = Date.parse('2026-10-28T12:00:00Z');
  const at = ms => new Date(baseTime + ms).toISOString();
  const timers = real ? { setTimeout, clearTimeout } : { setTimeout: () => 1, clearTimeout() {} };
  const port = {
    onMessage: { addListener(fn) { messages.push(fn); } },
    onDisconnect: { addListener(fn) { disconnects.push(fn); } },
    disconnect() { for (const fn of disconnects) fn(); },
    postMessage(message) {
      queueMicrotask(() => {
        const response = message.type === 'status'
          ? { id: message.id, type: 'status', protocolVersion: 1, authorized: true, guardEpoch: epoch, browserFamily: family, expiresInSeconds: guardTtl }
          : { id: message.id, type: 'pair', browserFamily: family, proof: 'single-use-proof' };
        for (const fn of messages) fn(response);
      });
    },
  };
  const adapter = create({ browserFamily: family, timers, now: real ? () => performance.now() : () => clock,
    runtime: { connectNative: () => port, getManifest: () => ({ version: '3.0.3.1' }) },
    storage: { get: async () => stored, set: async value => Object.assign(stored, value) },
    origin: () => serverOrigin, capabilities: () => ['scopedAuthorityChecksV1'],
    adopt: async value => adopted.push(value), invalidate: async reason => invalidations.push(reason), frame: async value => frames.push(value),
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      if (fetchOverride) return fetchOverride(url, init);
      if (url.endsWith('/pair')) {
        if (holdPair) await new Promise(resolve => { pendingPair = resolve; });
        return Response.json({ studentToken: 'cpw1.browser.synthetic', browserFamily: responseFamily, sourceRef, bindingRevision: 2,
          acceptedCapabilities: ['scopedAuthorityChecksV1'], guardExpiresAt: at(45000), absoluteExpiresAt: at(28800000), serverTime: at(0) });
      }
      return Response.json({ serverTime: at(0), guardExpiresAt: at(40000), messages: [{ type: 'synthetic' }] });
    } });
  return { adapter, calls, invalidations, adopted, frames, stored, port, setClock: n => { clock = n; },
    emit: value => messages.forEach(fn => fn(value)), releasePair: () => pendingPair?.(), epoch, sourceRef, setOrigin: value => { serverOrigin=value; } };
}
test('Windows pairing uses native proof without storing credentials and exact source transport', async () => {
  const f = fixture(); await f.adapter.start();
  const pair = JSON.parse(f.calls[0].body);
  assert.equal(pair.proof, 'single-use-proof'); assert.match(pair.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(f.stored), ['windowsProfileId']);
  assert.equal(f.adopted.length, 1);
  await f.adapter.request('heartbeat', { body: JSON.stringify({ activeTabUrl: 'https://synthetic.example/page' }) });
  const call = f.calls[1]; assert.equal(call.headers.Authorization, 'Bearer cpw1.browser.synthetic');
  assert.deepEqual(JSON.parse(call.body), { activeTabUrl: 'https://synthetic.example/page', sourceRef: f.sourceRef, bindingRevision: 2 });
  assert.equal(f.frames.length, 0); await f.adapter.drain(); assert.equal(f.frames.length, 1); f.adapter.reset('test-end');
});
test('guard disconnect immediately retires both credential and delayed pairing response', async () => {
  const f = fixture({ holdPair: true }); const start = f.adapter.start();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  f.port.disconnect(); f.releasePair();
  await assert.rejects(start); assert.equal(f.adopted.length, 0); assert.throws(() => f.adapter.active());
});
test('a different browser family or malformed guard cannot authenticate', async () => {
  const f = fixture({ family: 'edge', responseFamily: 'chrome' });
  await assert.rejects(f.adapter.start()); assert.equal(f.adopted.length, 0);
  const invalid = fixture({ guardTtl: 46 }); await assert.rejects(invalid.adapter.start()); assert.equal(invalid.calls.length, 0);
});
test('guard epoch changes and monotonic expiry clear browser authority', async () => {
  const f = fixture(); await f.adapter.start();
  f.emit({ type: 'status', protocolVersion: 1, authorized: true, guardEpoch: randomUUID(), browserFamily: 'chrome', expiresInSeconds: 45 });
  assert.throws(() => f.adapter.active());
  const expired = fixture(); await expired.adapter.start(); expired.setClock(46000); assert.throws(() => expired.adapter.active());
});
test('deadlines subtract transport time and legacy routing is an explicit allowlist', () => {
  assert.equal(deadline('2026-10-28T00:00:45Z', '2026-10-28T00:00:00Z', 100, 1100), 45100);
  assert.equal(route('/api/device/heartbeat'), 'heartbeat'); assert.equal(route('/api/extension/screenshot'), 'screenshot');
  assert.equal(route('/api/admin/users'), null); assert.equal(route('/api/classpilot/commands'), null);
});


test('origin changes before a request or during delayed pairing cannot leak a credential',async()=>{
  const active=fixture();await active.adapter.start();active.setOrigin('https://different.example');
  await assert.rejects(active.adapter.request('heartbeat'));assert.equal(active.calls.length,1);
  const pairing=fixture({holdPair:true});const pending=pairing.adapter.start();
  while(!pairing.calls.length)await new Promise(done=>setImmediate(done));
  pairing.setOrigin('https://different.example');pairing.releasePair();
  await assert.rejects(pending);assert.equal(pairing.adopted.length,0);
});

test('explicit retirement blocks the same guard epoch and stale requests immediately',async()=>{
  const f=fixture();await f.adapter.start();
  const prior=f.calls.length;
  await f.adapter.retire('explicit_sign_out',{suppressPairing:true,notifyBackend:true});
  assert.throws(()=>f.adapter.active());assert.equal(f.stored.windowsRetiredGuardEpoch,f.epoch);
  const end=f.calls[prior];assert.ok(end.url.endsWith('/action'));assert.equal(JSON.parse(end.body).operation,'sign-out');
  await assert.rejects(f.adapter.start());
  assert.equal(f.calls.length,prior+1,'Same-epoch signout cannot exchange another pairing proof');
});

async function httpFixture() {
  const modes = new Map(), held = [], received = [];
  let f;
  const server = createServer(async (req, res) => {
    const operation = req.url.split('/').at(-1);
    let raw = ''; for await (const chunk of req) raw += chunk;
    received.push({ operation, authorization: req.headers.authorization });
    const payload = operation === 'pair'
      ? { studentToken: 'cpw1.browser.synthetic-http', browserFamily: 'chrome', sourceRef: f.sourceRef, bindingRevision: 2,
        acceptedCapabilities: [], serverTime: '2026-10-28T12:00:00Z', guardExpiresAt: '2026-10-28T12:00:45Z', absoluteExpiresAt: '2026-10-28T20:00:00Z' }
      : { ok: true, serverTime: '2026-10-28T12:00:00Z', guardExpiresAt: '2026-10-28T12:00:45Z', messages: [{ type: 'synthetic-http' }] };
    const mode = modes.get(operation) || 'success';
    res.writeHead(201, 'Created', { 'Content-Type': 'application/json', 'X-Fixture': 'preserved',
      ...(mode === 'oversized-header' ? { 'Content-Length': 2 * 1024 * 1024 + 1 } : { 'Transfer-Encoding': 'chunked' }) });
    if (mode === 'hold') { const json = JSON.stringify(payload); res.write(json.slice(0, 1)); held.push({ operation, release: () => res.end(json.slice(1)), res }); }
    else if (mode === 'malformed') res.end('{malformed');
    else if (mode === 'oversized') { res.write('{"padding":"'); res.end('x'.repeat(2 * 1024 * 1024) + '"}'); }
    else if (mode === 'oversized-header') res.flushHeaders();
    else res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  f = fixture({ real: true, initialOrigin: origin, fetchOverride: fetch });
  return { ...f, modes, held, received,
    wait: async predicate => { const end = performance.now() + 3000; while (!predicate()) { if (performance.now() > end) throw new Error('HTTP_FIXTURE_NOT_READY'); await new Promise(resolve => setTimeout(resolve, 10)); } },
    close: async () => { f.adapter.reset('test-end'); for (const item of held) item.res.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('all operation bodies share the actual five-second HTTP deadline after headers', { timeout: 12_000 }, async () => {
  const f = await httpFixture();
  try {
    const owned = await f.adapter.start();
    const operations = ['heartbeat', 'action', 'screenshot', 'command-acks'];
    operations.forEach(operation => f.modes.set(operation, 'hold'));
    const started = performance.now();
    const outcomes = Promise.allSettled(operations.map(operation => f.adapter.request(operation, { body: '{}' })));
    await f.wait(() => f.held.length === operations.length);
    assert.ok((await outcomes).every(result => result.status === 'rejected'));
    assert.ok(performance.now() - started >= 4800, 'must test the real five-second budget');
    assert.ok(performance.now() - started < 10_000, 'held bodies cannot outlive the bounded request');
    assert.equal(owned.studentToken, '', 'retired references no longer retain the browser credential');
    assert.deepEqual(f.frames, []); assert.throws(() => f.adapter.active());
  } finally { await f.close(); }
});

test('completed JSON responses preserve status/headers and malformed or oversized streams fail closed', { timeout: 10_000 }, async () => {
  const f = await httpFixture();
  try {
    await f.adapter.start();
    const response = await f.adapter.request('action', { body: '{}' });
    assert.equal(response.status, 201); assert.equal(response.statusText, 'Created');
    assert.equal(response.headers.get('X-Fixture'), 'preserved');
    assert.equal((await response.clone().json()).ok, true); assert.equal((await response.json()).ok, true);
    for (const [mode, code] of [['malformed', 'WINDOWS_RESPONSE_INVALID'], ['oversized', 'WINDOWS_RESPONSE_TOO_LARGE'], ['oversized-header', 'WINDOWS_RESPONSE_TOO_LARGE']]) {
      f.modes.set('screenshot', mode);
      await assert.rejects(f.adapter.request('screenshot', { body: '{}' }), error => error.code === code);
      assert.throws(() => f.adapter.active());
      f.modes.set('screenshot', 'success');
      assert.equal((await f.adapter.request('screenshot', { body: '{}' })).status, 201);
    }
  } finally { await f.close(); }
});

test('guard retirement aborts a held real body and never dispatches its late frames', { timeout: 8000 }, async () => {
  const f = await httpFixture();
  try {
    const owned = await f.adapter.start(); f.modes.set('heartbeat', 'hold');
    const pending = f.adapter.request('heartbeat', { body: '{}' });
    const rejected = assert.rejects(pending);
    await f.wait(() => f.held.length === 1);
    const started = performance.now(); await f.adapter.retire('guard-retired'); await rejected;
    assert.ok(performance.now() - started < 1000); assert.equal(owned.studentToken, '');
    f.held[0].release(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.frames, []); assert.throws(() => f.adapter.active());
    assert.deepEqual(Object.keys(f.stored), ['windowsProfileId']);
  } finally { await f.close(); }
});

test('caller cancellation stops one held body without retiring a current guard', { timeout: 8000 }, async () => {
  const f = await httpFixture();
  try {
    const owned = await f.adapter.start(), controller = new AbortController(); f.modes.set('action', 'hold');
    const pending = f.adapter.request('action', { body: '{}', signal: controller.signal });
    const rejected = assert.rejects(pending, error => error.code === 'WINDOWS_REQUEST_CANCELLED');
    await f.wait(() => f.held.length === 1); controller.abort(); await rejected;
    assert.equal(f.adapter.active(), owned); assert.ok(owned.studentToken.startsWith('cpw1.browser.'));
    f.modes.set('action', 'success'); assert.equal((await f.adapter.request('action', { body: '{}' })).status, 201);
  } finally { await f.close(); }
});

test('pair response body timeout and origin changes never adopt or forward a browser credential', { timeout: 12_000 }, async () => {
  const f = await httpFixture();
  try {
    f.modes.set('pair', 'hold');
    const first = f.adapter.start(), firstRejected = assert.rejects(first, error => error.code === 'WINDOWS_REQUEST_TIMEOUT');
    await f.wait(() => f.held.length === 1); await firstRejected;
    assert.equal(f.adopted.length, 0);
    const second = f.adapter.start(), secondRejected = assert.rejects(second);
    await f.wait(() => f.held.length === 2); f.setOrigin('http://127.0.0.1:1'); f.held[1].release(); await secondRejected;
    assert.equal(f.adopted.length, 0); assert.equal(f.calls.length, 2);
    assert.ok(f.received.every(request => request.operation === 'pair' && request.authorization === undefined));
    assert.deepEqual(Object.keys(f.stored), ['windowsProfileId']);
  } finally { await f.close(); }
});

test('best-effort sign-out also bounds its response body and clears retired references immediately', { timeout: 12_000 }, async () => {
  const f = await httpFixture();
  try {
    const owned = await f.adapter.start(); f.modes.set('action', 'hold');
    const pending = f.adapter.retire('explicit-sign-out', { notifyBackend: true });
    assert.equal(owned.studentToken, ''); assert.throws(() => f.adapter.active());
    await f.wait(() => f.held.length === 1); assert.equal(await pending, false);
  } finally { await f.close(); }
});
