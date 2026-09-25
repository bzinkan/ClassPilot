// Runs only in the extension worker. IndexedDB is scoped to the extension
// origin; content scripts use their host page's separate IndexedDB origin.
(() => {
  'use strict';
  const DATABASE = 'classpilot-private-recovery-v1';
  const STORE = 'recovery';
  const KEY = 'student-session-recovery';
  const CODES = new Set([
    'RECOVERY_STORE_UNAVAILABLE', 'RECOVERY_STORE_READ_FAILED',
    'RECOVERY_STORE_WRITE_FAILED', 'RECOVERY_STORE_MIGRATION_FAILED',
  ]);
  const failure = code => Object.assign(new Error('Private recovery storage is unavailable'), { code });

  function create({ indexedDB, readLegacy, removeLegacy, normalize }) {
    let database = null;
    let opening = null;
    let tail = Promise.resolve();
    let pendingLoad = null;
    const status = { phase: 'opening', attemptCount: 0 };

    function openDatabase() {
      if (database) return Promise.resolve(database);
      if (opening) return opening;
      status.phase = 'opening';
      const requestPromise = new Promise((resolve, reject) => {
        let request;
        try {
          if (typeof indexedDB?.open !== 'function') throw failure('RECOVERY_STORE_UNAVAILABLE');
          request = indexedDB.open(DATABASE, 1);
        } catch {
          reject(failure('RECOVERY_STORE_UNAVAILABLE'));
          return;
        }
        request.onupgradeneeded = () => {
          try {
            if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
          } catch {
            // The open request fails only after the upgrade transaction aborts.
            request.transaction.abort();
          }
        };
        request.onerror = () => reject(failure('RECOVERY_STORE_UNAVAILABLE'));
        request.onsuccess = () => {
          const opened = request.result;
          database = opened;
          opened.onversionchange = () => {
            opened.close();
            if (database === opened) database = null;
          };
          opened.onclose = () => { if (database === opened) database = null; };
          resolve(opened);
        };
        // A blocked open is still pending work. Keep its owner until IndexedDB
        // completes or rejects it; a timer cannot cancel its future effects.
      });
      const tracked = requestPromise.finally(() => { if (opening === tracked) opening = null; });
      opening = tracked;
      return tracked;
    }

    async function transaction(mode, code, operation) {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        let tx;
        let result;
        try { tx = db.transaction(STORE, mode); }
        catch {
          if (database === db) database = null;
          reject(failure(code));
          return;
        }
        // Request success is not commit. Do not publish capability or start a
        // legacy purge until the entire transaction has committed.
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(failure(code));
        tx.onerror = () => {}; // Preserve IndexedDB's default transaction abort.
        const abort = () => {
          try { tx.abort(); }
          catch { reject(failure(code)); }
        };
        try { operation(tx.objectStore(STORE), value => { result = value; }, abort); }
        catch { abort(); }
      });
    }

    function decode(record, code) {
      if (!record || record.schemaVersion !== 1 || record.migrated !== true
        || !Object.prototype.hasOwnProperty.call(record, 'state')) throw failure(code);
      try { return normalize(record.state); }
      catch { throw failure(code); }
    }

    async function readRecord() {
      await openDatabase();
      status.phase = 'reading';
      return transaction('readonly', 'RECOVERY_STORE_READ_FAILED', (store, accept) => {
        const request = store.get(KEY);
        request.onsuccess = () => accept(request.result);
      });
    }

    async function migrateIfAbsent(legacy) {
      status.phase = 'migrating';
      return transaction('readwrite', 'RECOVERY_STORE_MIGRATION_FAILED', (store, accept, abort) => {
        const request = store.get(KEY);
        request.onsuccess = () => {
          try {
            if (request.result !== undefined) {
              // Another extension-owned connection may have completed migration
              // while legacy storage was read. Its committed marker wins.
              accept(decode(request.result, 'RECOVERY_STORE_MIGRATION_FAILED'));
              return;
            }
            store.put({ schemaVersion: 1, migrated: true, state: legacy }, KEY);
            accept(legacy);
          } catch { abort(); }
        };
      });
    }

    async function loadAndCleanLegacy() {
      let record = await readRecord();
      let state;
      if (record === undefined) {
        status.phase = 'migrating';
        let legacy;
        try { legacy = normalize(await readLegacy()); }
        catch { throw failure('RECOVERY_STORE_MIGRATION_FAILED'); }
        state = await migrateIfAbsent(legacy);
      } else {
        state = decode(record, 'RECOVERY_STORE_READ_FAILED');
      }
      status.phase = 'purging';
      // The marker is committed even for empty state. A restart after this
      // copy or a later clear may clean legacy again, but can never reimport it.
      try { await removeLegacy(); }
      catch { throw failure('RECOVERY_STORE_MIGRATION_FAILED'); }
      return state;
    }

    function enqueue(operation) {
      const run = tail.then(async () => {
        status.attemptCount += 1;
        delete status.failureClass;
        try {
          const value = await operation();
          status.phase = 'ready';
          return value;
        } catch (error) {
          status.phase = 'failed';
          status.failureClass = CODES.has(error?.code) ? error.code : 'RECOVERY_STORE_UNAVAILABLE';
          throw failure(status.failureClass);
        }
      });
      tail = run.catch(() => {});
      return run;
    }

    function load() {
      if (pendingLoad) return pendingLoad;
      const run = enqueue(loadAndCleanLegacy);
      const tracked = run.finally(() => { if (pendingLoad === tracked) pendingLoad = null; });
      pendingLoad = tracked;
      tracked.catch(() => {});
      return tracked;
    }

    function persist(nextState) {
      return enqueue(async () => {
        await loadAndCleanLegacy();
        let state;
        try { state = normalize(nextState); }
        catch { throw failure('RECOVERY_STORE_WRITE_FAILED'); }
        status.phase = 'writing';
        await transaction('readwrite', 'RECOVERY_STORE_WRITE_FAILED', store => {
          store.put({ schemaVersion: 1, migrated: true, state }, KEY);
        });
        return state;
      });
    }

    return Object.freeze({ load, persist, getStatus: () => ({ ...status }) });
  }

  globalThis.ClassPilotPrivateRecoveryStore = Object.freeze({ create });
})();
