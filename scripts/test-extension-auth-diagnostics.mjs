import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const sourceRoot = process.env.CLASSPILOT_EXTENSION_PATH || resolve('extension');
const source = readFileSync(resolve(sourceRoot, 'auth-recovery-diagnostics.js'), 'utf8');
function factory() {
  const sandbox = { console: { warn() {} } };
  vm.runInNewContext(source, sandbox);
  return sandbox.ClassPilotAuthRecoveryDiagnosticsFactory;
}

function support() {
  const sandbox = { console: { warn() {} }, chrome: { runtime: { getManifest: () => ({ version: '2.9.4' }) } } };
  vm.runInNewContext(source, sandbox);
  return sandbox.ClassPilotAuthSupportDetails;
}

test('diagnostics whitelist data, deduplicate for a minute, and bound retained history', () => {
  let timestamp = 1_000;
  const warnings = [];
  const recorder = factory().createRecorder({ version: '2.8.7', now: () => timestamp, warn: (...args) => warnings.push(args) });
  const secret = 'student@example.test https://private.test/token bearer-secret';
  assert.equal(recorder.record({ stage: 'policy_read', cause: 'timeout', elapsedMs: 3000, attemptCount: 2, message: secret, studentId: secret }), true);
  assert.equal(recorder.record({ stage: 'policy_read', cause: 'timeout' }), false);
  assert.equal(recorder.record({ stage: secret, cause: 'timeout' }), false);
  timestamp += 60_000;
  assert.equal(recorder.record({ stage: 'policy_read', cause: 'timeout' }), true);
  for (let index = 0; index < 30; index += 1) {
    timestamp += 60_000;
    recorder.record({ stage: 'message_transport', cause: 'channel_closed', elapsedMs: 9e9, attemptCount: 9e9 });
  }
  const history = recorder.snapshot();
  assert.equal(history.length, 20);
  assert.equal(history.at(-1).elapsedMs, 60_000);
  assert.equal(history.at(-1).attemptCount, 100);
  assert.equal(JSON.stringify({ history, warnings }).includes(secret), false);
  assert.deepEqual(Object.keys(history[0]).sort(), ['attemptCount', 'cause', 'elapsedMs', 'extensionVersion', 'stage', 'timestamp']);
});

test('a hung storage read never blocks or creates an unbounded storage queue', () => {
  let timestamp = 0;
  let reads = 0;
  let writes = 0;
  const recorder = factory().createRecorder({
    version: '2.8.7', now: () => timestamp,
    storage: { get() { reads += 1; }, set() { writes += 1; } },
  });
  for (let index = 0; index < 100; index += 1) {
    timestamp += 60_000;
    recorder.record({ stage: 'startup', cause: 'timeout' });
  }
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  assert.equal(recorder.snapshot().length, 20);
});

test('transport failure codes normalize to fixed operational stages and causes', () => {
  const recorder = factory().createRecorder({ version: '2.8.7' });
  assert.equal(recorder.record({ stage: 'frame_roster', cause: 'AUTH_GATE_RPC_TIMEOUT' }), true);
  assert.equal(recorder.snapshot()[0].stage, 'roster');
  assert.equal(recorder.snapshot()[0].cause, 'timeout');
  assert.equal(recorder.record({ stage: 'runtime_rpc', cause: 'AUTH_GATE_CONTEXT_INVALIDATED' }), true);
  assert.equal(recorder.snapshot()[1].cause, 'context_invalidated');
  assert.equal(recorder.record({ stage: 'runtime_rpc', cause: 'AUTH_GATE_REQUEST_CANCELLED' }), false);
  assert.equal(recorder.record(null), false);
});

test('session history is sanitized before merging and failures retain memory evidence', () => {
  let persisted;
  const recorder = factory().createRecorder({
    version: '2.8.7', now: () => 2000,
    storage: {
      get(_keys, callback) { callback({ authGateDiagnosticsV1: [
        { timestamp: 1000, extensionVersion: '2.8.7', stage: 'startup', cause: 'timeout', secret: 'do-not-copy' },
        { timestamp: 1001, extensionVersion: 'secret-token', stage: 'startup', cause: 'timeout' },
      ] }); },
      set(value, callback) { persisted = value; callback(); },
    },
    warn() { throw new Error('unavailable console'); },
    relay() { throw new Error('unavailable runtime'); },
  });
  assert.equal(recorder.record({ stage: 'policy_read', cause: 'recovered' }), true);
  assert.equal(recorder.snapshot().length, 2);
  assert.equal(JSON.stringify(persisted).includes('secret'), false);
});

test('2.9.4 wake diagnostics carry an optional fixed step name and nothing else', () => {
  let timestamp = 1_000;
  const recorder = factory().createRecorder({ version: '2.9.4', now: () => timestamp });
  const secret = 'student@example.test https://private.test/token';
  assert.equal(recorder.record({ stage: 'startup', cause: 'wake_failed', detail: 'auth_snapshot', message: secret }), true);
  timestamp += 60_000;
  assert.equal(recorder.record({ stage: 'startup', cause: 'wake_abandoned', detail: `Not a step ${secret}` }), true);
  const [failed, abandoned] = recorder.snapshot();
  assert.equal(failed.cause, 'wake_failed');
  assert.equal(failed.detail, 'auth_snapshot');
  assert.deepEqual(Object.keys(failed).sort(), ['attemptCount', 'cause', 'detail', 'elapsedMs', 'extensionVersion', 'stage', 'timestamp']);
  assert.equal(abandoned.cause, 'wake_abandoned');
  assert.equal('detail' in abandoned, false, 'a detail that is not a fixed step name is dropped');
  assert.equal(JSON.stringify(recorder.snapshot()).includes('secret'), false);
  assert.equal(JSON.stringify(recorder.snapshot()).includes('private.test'), false);
  timestamp += 60_000;
  recorder.record({ stage: 'startup', cause: 'wake_failed', detail: 'jane_doe' });
  assert.equal('detail' in recorder.snapshot().at(-1), false, 'identifier-shaped names are not operation names');
});

test('support snapshots use explicit classes and steps and bound every displayed field', () => {
  const api = support();
  const value = api.sanitize({ extensionVersion: '2.9.4', startupPhase: 'recovery_policy_read',
    elapsedMs: 1e9, restoreOutcome: 'failed', failureClass: 'STORAGE_IO_ERROR', attemptCount: 1e9, retryInMs: 1e9,
    pending: true, token: 'private-token', firstFailure: {
      startupPhase: 'auth_snapshot', failureClass: 'STORAGE_QUOTA_EXCEEDED', timestamp: 1000, studentId: 'private-student',
    } });
  assert.deepEqual(Object.keys(value).sort(), ['attemptCount', 'elapsedMs', 'extensionVersion', 'failureClass', 'firstFailure', 'pending', 'restoreOutcome', 'retryInMs', 'startupPhase', 'timestamp']);
  assert.equal(value.attemptCount, 100); assert.equal(value.retryInMs, 300_000); assert.equal(value.elapsedMs, 60_000);
  const text = api.format(value, 'AUTH_GATE_STARTUP_TIMEOUT');
  assert.match(text, /First failure: auth_snapshot \/ STORAGE_QUOTA_EXCEEDED/);
  assert.equal(text.includes('private'), false);
  const invalid = api.sanitize({ extensionVersion: 'private-token', startupPhase: 'jane_doe',
    restoreOutcome: 'private-restore', failureClass: 'john_smith', pending: 'true',
    firstFailure: { startupPhase: 'jane_doe', failureClass: 'Error', timestamp: 1000 } });
  assert.equal(invalid.startupPhase, 'unknown'); assert.equal(invalid.failureClass, 'Error');
  assert.equal(invalid.extensionVersion, 'unknown'); assert.equal('pending' in invalid, false);
  assert.equal('firstFailure' in invalid, false);
  assert.equal(api.format(invalid, 'private-code').includes('private'), false);
  assert.equal(api.sanitize(null), null);
  assert.equal(api.fallback('AUTH_GATE_RPC_TIMEOUT').startupPhase, 'worker_unavailable');
  for (const startupPhase of ['legacy_auth_cleanup', 'auth_context_persist', 'retired_storage_cleanup', 'recovery_policy_cleanup']) {
    assert.equal(api.sanitize({ startupPhase }).startupPhase, startupPhase);
  }
});

test('local fallback omits unknown worker evidence and labels only measured page time', () => {
  const api = support();
  const details = api.fallback('AUTH_GATE_RPC_TIMEOUT');
  assert.deepEqual(Object.keys(details).sort(), ['extensionVersion', 'failureClass', 'startupPhase', 'timestamp']);
  assert.equal(details.extensionVersion, '2.9.4');
  assert.equal(details.failureClass, 'AUTH_GATE_RPC_TIMEOUT');
  assert.equal(details.startupPhase, 'worker_unavailable');
  assert.ok(details.timestamp > 0);
  assert.doesNotMatch(api.format(details, 'AUTH_GATE_RPC_TIMEOUT'), /Elapsed:|Restore:|Recovery attempt:|Operation pending:|Retry in:|First failure:/);
  const measured = api.sanitize({ ...details, elapsedMs: 10_000 });
  assert.match(api.format(measured, 'AUTH_GATE_RPC_TIMEOUT'), /Page request elapsed: 10000 ms/);
  const invalid = api.sanitize({ ...details, elapsedMs: Infinity, retryInMs: NaN, attemptCount: '1', pending: 'true', restoreOutcome: 'private' });
  assert.deepEqual(Object.keys(invalid).sort(), Object.keys(details).sort());
});

test('later missing-worker replies retain only the first known causal failure until the caller clears it', () => {
  const api = support();
  const original = api.sanitize({ startupPhase: 'recovery_clear', failureClass: 'Error', pending: true,
    firstFailure: { startupPhase: 'auth_snapshot', failureClass: 'STORAGE_IO_ERROR', timestamp: 1000, token: 'private-token' } });
  const absent = api.retainFirstFailure(original, null, 'AUTH_GATE_RPC_TIMEOUT');
  assert.deepEqual(JSON.parse(JSON.stringify(absent.firstFailure)), {
    startupPhase: 'auth_snapshot', failureClass: 'STORAGE_IO_ERROR', timestamp: 1000,
  });
  assert.equal(absent.startupPhase, 'worker_unavailable');
  assert.equal('pending' in absent, false, 'an old worker pending flag must not become current page evidence');
  const repeated = api.retainFirstFailure(absent, { firstFailure: {
    startupPhase: 'recovery_policy_read', failureClass: 'TypeError', timestamp: 2000,
  } }, 'AUTH_GATE_UNAVAILABLE');
  assert.equal(repeated.firstFailure.failureClass, 'STORAGE_IO_ERROR');
  assert.equal(JSON.stringify(repeated).includes('private'), false);
  assert.equal('firstFailure' in api.retainFirstFailure(null, null, 'AUTH_GATE_RPC_TIMEOUT'), false);
});
