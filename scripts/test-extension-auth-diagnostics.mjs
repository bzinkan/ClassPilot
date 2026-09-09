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
