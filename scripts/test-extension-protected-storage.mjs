import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const extensionSource = name => readFileSync(process.env.CLASSPILOT_EXTENSION_PATH
  ? join(process.env.CLASSPILOT_EXTENSION_PATH, name)
  : new URL(`../extension/${name}`, import.meta.url), 'utf8');
const source = extensionSource('service-worker.js').replace(/\r\n/g, '\n');
const storeSource = extensionSource('private-recovery-store.js');
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const clone = value => value === undefined ? undefined : structuredClone(value);
const empty = () => ({ schemaVersion: 1, armed: null, pending: [] });
const capability = name => ({ schemaVersion: 1, armed: { fixture: name }, pending: [] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// A controllable native transaction boundary. Production store code is executed
// unchanged; requests can succeed before a transaction is committed or aborted.
function indexedDbFixture() {
  const f = { record: undefined, events: [], waiting: [], openFailures: 0,
    abortRead: false, abortWrite: false, holdCommit: () => false, opens: 0 };
  const db = {
    objectStoreNames: { contains: () => true },
    close() {},
    transaction(_name, mode) {
      let outstanding = 0, finished = false, scheduled = false;
      let next = clone(f.record), written = false;
      const tx = {
        mode,
        abort() {
          if (finished) return;
          finished = true;
          queueMicrotask(() => tx.onabort?.());
        },
        commit() {
          if (finished) return;
          const flag = mode === 'readwrite' ? 'abortWrite' : 'abortRead';
          if (f[flag]) { f[flag] = false; tx.abort(); return; }
          finished = true;
          if (written) f.record = clone(next);
          f.events.push(`commit:${mode}`);
          tx.oncomplete?.();
        },
        objectStore() {
          function request(operation) {
            const result = {};
            outstanding++;
            queueMicrotask(() => {
              if (finished) return;
              try { result.result = operation(); result.onsuccess?.(); }
              catch { tx.abort(); return; }
              f.events.push(`request:${mode}`);
              outstanding--;
              if (outstanding === 0 && !scheduled) {
                scheduled = true;
                queueMicrotask(() => {
                  if (finished) return;
                  if (f.holdCommit(tx)) f.waiting.push(tx);
                  else tx.commit();
                });
              }
            });
            return result;
          }
          return {
            get: () => request(() => clone(next)),
            put: value => request(() => { next = clone(value); written = true; }),
          };
        },
      };
      return tx;
    },
  };
  f.indexedDB = {
    open() {
      f.opens++;
      const request = {};
      queueMicrotask(() => {
        if (f.openFailures > 0) { f.openFailures--; request.onerror?.(); }
        else { request.result = db; request.onsuccess?.(); }
      });
      return request;
    },
  };
  return f;
}

function fixture({ native = indexedDbFixture(), legacy = capability('old') } = {}) {
  const context = vm.createContext({});
  vm.runInContext(storeSource, context);
  const f = { native, legacy, legacyReads: 0, purges: 0, purgeGate: null, purgeFailure: false };
  f.create = () => context.ClassPilotPrivateRecoveryStore.create({
    indexedDB: native.indexedDB,
    normalize: value => clone(value || empty()),
    readLegacy: async () => { f.legacyReads++; return clone(f.legacy); },
    removeLegacy: async () => {
      f.purges++;
      native.events.push('purge');
      if (f.purgeGate) await f.purgeGate.promise;
      if (f.purgeFailure) throw new Error('private native purge message');
      f.legacy = undefined;
    },
  });
  f.store = f.create();
  return f;
}

test('legacy capability is committed privately before cleanup or publication', async () => {
  const f = fixture();
  f.native.holdCommit = tx => tx.mode === 'readwrite';
  let published = false;
  const loading = f.store.load().then(value => { published = true; return value; });
  await flush();
  assert.equal(f.store.getStatus().phase, 'migrating');
  assert.equal(f.native.record, undefined);
  assert.equal(f.purges, 0);
  assert.equal(published, false);
  assert.equal(f.native.waiting.length, 1);
  f.native.waiting[0].commit();
  assert.deepEqual(await loading, capability('old'));
  assert.equal(f.native.record.migrated, true);
  assert.equal(f.legacy, undefined);
  assert.ok(f.native.events.indexOf('commit:readwrite') < f.native.events.indexOf('purge'));
});

test('a restart after committed migration only retries cleanup and never reimports legacy', async () => {
  const f = fixture();
  f.purgeFailure = true;
  await assert.rejects(f.store.load(), { code: 'RECOVERY_STORE_MIGRATION_FAILED' });
  assert.equal(f.native.record.migrated, true);
  assert.equal(f.legacyReads, 1);
  f.legacy = capability('stale replacement');
  f.purgeFailure = false;
  assert.deepEqual(await f.create().load(), capability('old'));
  assert.equal(f.legacyReads, 1);
  assert.equal(f.legacy, undefined);
});

test('empty private state retains its marker and cannot resurrect a stale legacy capability', async () => {
  const f = fixture();
  await f.store.load();
  await f.store.persist(empty());
  assert.deepEqual(f.native.record, { schemaVersion: 1, migrated: true, state: empty() });
  f.legacy = capability('old');
  assert.deepEqual(await f.create().load(), empty());
  assert.equal(f.legacyReads, 1);
  assert.equal(f.legacy, undefined);
});

test('simultaneous retries join a pending purge and replacement writes keep their queue ownership', async () => {
  const f = fixture();
  f.purgeGate = deferred();
  const loading = f.store.load();
  for (let i = 0; i < 20; i++) assert.equal(f.store.load(), loading);
  const clearing = f.store.persist(empty());
  const replacing = f.store.persist(capability('new'));
  await flush();
  assert.equal(f.store.getStatus().phase, 'purging');
  assert.equal(f.store.getStatus().attemptCount, 1);
  assert.equal(f.purges, 1);
  assert.deepEqual(f.native.record.state, capability('old'));
  const firstPurge = f.purgeGate;
  f.purgeGate = null;
  f.native.holdCommit = tx => tx.mode === 'readwrite';
  firstPurge.resolve();
  await loading;
  await flush();
  assert.equal(f.store.getStatus().phase, 'writing');
  assert.equal(f.store.getStatus().attemptCount, 2);
  assert.deepEqual(f.native.record.state, capability('old'));
  assert.equal(f.native.waiting.length, 1);
  const clearTransaction = f.native.waiting[0];
  f.native.holdCommit = () => false;
  clearTransaction.commit();
  assert.deepEqual(f.native.record.state, empty());
  await clearing;
  await replacing;
  assert.deepEqual(f.native.record.state, capability('new'));
  firstPurge.resolve();
  clearTransaction.commit();
  await flush();
  assert.deepEqual(f.native.record.state, capability('new'));
});

test('settled open, read, migration and write failures retry without publishing uncommitted state', async () => {
  const f = fixture();
  f.native.openFailures = 1;
  await assert.rejects(f.store.load(), { code: 'RECOVERY_STORE_UNAVAILABLE' });
  assert.equal(f.purges, 0);
  f.native.abortRead = true;
  await assert.rejects(f.store.load(), { code: 'RECOVERY_STORE_READ_FAILED' });
  assert.equal(f.purges, 0);
  f.native.abortWrite = true;
  await assert.rejects(f.store.load(), { code: 'RECOVERY_STORE_MIGRATION_FAILED' });
  assert.equal(f.native.record, undefined);
  assert.equal(f.purges, 0);
  assert.deepEqual(await f.store.load(), capability('old'));
  f.native.abortWrite = true;
  await assert.rejects(f.store.persist(capability('new')), { code: 'RECOVERY_STORE_WRITE_FAILED' });
  assert.deepEqual(f.native.record.state, capability('old'));
  assert.deepEqual(await f.store.persist(capability('new')), capability('new'));
  assert.equal(f.store.getStatus().phase, 'ready');
});

test('an invalid private marker fails closed with fixed diagnostic fields and no private data', async () => {
  const f = fixture();
  f.native.record = { schemaVersion: 99, state: capability('private-token') };
  await assert.rejects(f.store.load(), { code: 'RECOVERY_STORE_READ_FAILED', message: 'Private recovery storage is unavailable' });
  assert.equal(f.legacyReads, 0);
  assert.equal(f.purges, 0);
  const status = JSON.parse(JSON.stringify(f.store.getStatus()));
  assert.deepEqual(status, { phase: 'failed', attemptCount: 1, failureClass: 'RECOVERY_STORE_READ_FAILED' });
  assert.equal(JSON.stringify(status).includes('private-token'), false);
});

function productionFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `Missing production function ${name}`);
  const tail = source.slice(match.index + match[0].length);
  const end = /^}/m.exec(tail);
  assert.ok(end);
  return source.slice(match.index, match.index + match[0].length + end.index + 1);
}

test('early modern local restriction is best effort and unsupported Chrome never purges before migration', async () => {
  let setup = 0, purges = 0, callback;
  const context = vm.createContext({ chrome: {
    storage: { local: {
      setAccessLevel(options, done) { assert.equal(options.accessLevel, 'TRUSTED_CONTEXTS'); setup++; callback = done; },
      remove() { purges++; },
    } },
    runtime: { lastError: { message: 'This StorageArea is not available for setting access level' } },
  } });
  const boundary = source.indexOf("\ntry {\n  importScripts('config.js');");
  assert.ok(boundary > 0);
  vm.runInContext(source.slice(0, boundary), context);
  assert.equal(setup, 1);
  callback();
  await flush();
  assert.equal(purges, 0);
  assert.equal(await context.restrictLocalStorageToTrustedContexts({ remove() { purges++; } }, {}), false);
  assert.equal(purges, 0);
});

test('actual recovery loader ignores stale wake snapshots and only installs verified committed private state', async () => {
  const native = indexedDbFixture();
  const disk = {};
  const context = vm.createContext({
    indexedDB: native.indexedDB,
    STUDENT_SESSION_RECOVERY_STORAGE_KEY: 'studentSessionRecoveryV1',
    studentSessionRecoveryLoaded: false,
    studentSessionRecoveryLoadPromise: null,
    studentSessionRecoveryState: empty(),
    normalizeStudentSessionRecoveryState: value => clone(value || empty()),
    scheduleStudentSessionRecoveryAlarm: async () => {},
    rawLocalKv: {
      get: async () => ({ ...disk }),
      remove: async key => { delete disk[key]; },
    },
  });
  context.installStudentSessionRecoveryState = value => {
    context.studentSessionRecoveryLoaded = true;
    context.studentSessionRecoveryState = value;
  };
  vm.runInContext(storeSource, context);
  vm.runInContext('let privateStudentSessionRecoveryStore = null;', context);
  for (const name of ['getPrivateStudentSessionRecoveryStore', 'ensureStudentSessionRecoveryLoaded', 'persistStudentSessionRecoveryState']) {
    vm.runInContext(productionFunction(name), context);
  }
  native.openFailures = 1;
  await assert.rejects(context.ensureStudentSessionRecoveryLoaded(capability('stale-snapshot')), { code: 'RECOVERY_STORE_UNAVAILABLE' });
  assert.equal(context.studentSessionRecoveryLoaded, false);
  await context.ensureStudentSessionRecoveryLoaded(capability('stale-snapshot'));
  assert.equal(context.studentSessionRecoveryLoaded, true);
  assert.deepEqual(context.studentSessionRecoveryState, empty());
  assert.deepEqual(native.record.state, empty());
  native.abortWrite = true;
  await assert.rejects(context.persistStudentSessionRecoveryState(capability('uncommitted')), { code: 'RECOVERY_STORE_WRITE_FAILED' });
  assert.deepEqual(context.studentSessionRecoveryState, empty());
  context.scheduleStudentSessionRecoveryAlarm = async () => { throw new Error('alarm unavailable'); };
  await assert.rejects(context.persistStudentSessionRecoveryState(capability('committed')), /alarm unavailable/);
  assert.deepEqual(native.record.state, capability('committed'));
  assert.deepEqual(context.studentSessionRecoveryState, capability('committed'));
});
