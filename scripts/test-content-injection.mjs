import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { resolve } from 'node:path';

const source = readFileSync(process.env.CLASSPILOT_EXTENSION_PATH
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH, 'content-injection.js')
  : new URL('../extension/content-injection.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture({ legacy = false, forged = false, ready = false, acknowledged = true, navigateDuringInstall = false, timeoutMs = 40 } = {}) {
  let documentId = 'document-one', permitted = true, current = true, installs = 0, reconciles = 0;
  let storageRead = null, storageWrite = null, authorization = null;
  const stored = {}, actions = [], commands = [];
  class Element { isConnected = true; }
  const gate = new Element();
  const page = vm.createContext({ Element, crypto: webcrypto, Uint8Array, Date,
    location: { protocol: 'https:', reload: () => actions.push('reload') },
    document: { getElementById: () => forged || legacy ? gate : null } });
  page.window = page; page.top = page;
  const install = () => {
    installs++;
    page.ClassPilotPageLifecycle = { protocol: 1, inspect: () => [
      { active: true, kind: 'bootstrap', version: '2.8.7', instanceId: 'bootstrap' },
      { active: true, kind: 'content', version: '2.8.7', instanceId: 'content', ownedGate: true, secureFrameOwned: true }],
      reconcile: () => reconciles++ };
    page.__classpilotAuthGateBootstrap = { active: true, gateRoot: gate };
  };
  if (legacy) { page.__CLASSPILOT_AUTH_GATE_BOOTSTRAP_LOADED__ = true; page.__classpilotAuthGateBootstrap = { active: true, gateRoot: gate }; }
  if (ready) { install(); installs = 0; }
  const chrome = { runtime: { id: 'extension-id' }, storage: { session: {
    get: async key => storageRead ? storageRead(key) : { [key]: stored[key] },
    set: async values => { actions.push('marker'); if (storageWrite) await storageWrite(values); Object.assign(stored, values); },
  } }, scripting: { executeScript: async command => {
    commands.push(command);
    if (command.target.documentIds && command.target.documentIds[0] !== documentId) throw new Error('document changed');
    if (command.files) {
      if (acknowledged) install(); else installs++;
      if (navigateDuringInstall) documentId = 'document-two';
      return [{ frameId: 0, documentId }];
    }
    page.argumentsForProbe = command.args;
    const result = vm.runInContext(`(${command.func.toString()})(...argumentsForProbe)`, page);
    return [{ frameId: 0, documentId, result }];
  } } };
  const worker = vm.createContext({ setTimeout, clearTimeout, Date }); vm.runInContext(source, worker);
  const options = { chrome, version: '2.8.7', files: ['helpers.js', 'bootstrap.js', 'content.js'], timeoutMs,
    authorizeReload: async input => authorization ? authorization(input) : permitted ? { allowed: true } : null,
    isReloadAuthorizationCurrent: () => current };
  const make = () => worker.ClassPilotContentInjection.create(options);
  const api = make();
  return { api, make, page, stored, actions, commands,
    get installs() { return installs; }, get reconciles() { return reconciles; },
    setDocument: value => { documentId = value; }, setPermitted: value => { permitted = value; }, setCurrent: value => { current = value; },
    setRead: value => { storageRead = value; }, setWrite: value => { storageWrite = value; }, setAuthorization: value => { authorization = value; },
    sender: { id: 'extension-id', tab: { id: 7 }, frameId: 0, documentId: 'document-one' } };
}

test('fresh exact-document install requires acknowledged controllers; same version only reconciles', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.api.ensure(7), f.api.ensure(7)]);
  assert.equal(first.status, 'ready'); assert.equal(second.status, 'ready'); assert.equal(f.installs, 1);
  assert.deepEqual(Array.from(f.commands.find(command => command.files).target.documentIds), ['document-one']);
  await f.api.ensure(7); assert.equal(f.installs, 1); assert.equal(f.reconciles, 1);
});

test('an unacknowledged or navigated injection is never remembered as installed', async () => {
  const failed = fixture({ acknowledged: false });
  assert.equal((await failed.api.ensure(7)).reason, 'installation_unconfirmed');
  assert.equal((await failed.api.ensure(7)).reason, 'installation_unconfirmed');
  assert.equal(failed.installs, 2);
  const navigated = fixture({ navigateDuringInstall: true });
  assert.equal((await navigated.api.ensure(7)).status, 'manual_reload_required');
  assert.deepEqual(navigated.actions, []);
});

test('legacy gate reload needs update opt-in and persists one marker before exact-document action', async () => {
  const f = fixture({ legacy: true });
  assert.equal((await f.api.ensure(7)).status, 'manual_reload_required');
  assert.equal((await f.api.ensure(7, { allowLegacyReload: true })).status, 'reloaded');
  assert.deepEqual(f.actions, ['marker', 'reload']); assert.equal(f.installs, 0);
  const result = await f.make().ensure(7, { allowLegacyReload: true });
  assert.equal(result.reason, 'already_attempted'); assert.equal(f.actions.filter(value => value === 'reload').length, 1);
  assert.deepEqual(Array.from(f.commands.find(command => command.args?.[0] === 'reload').target.documentIds), ['document-one']);
});

test('forged DOM, missing controller, signed-in/kiosk policy and stale policy cannot authorize reload', async () => {
  const forged = fixture({ forged: true });
  assert.equal((await forged.api.ensure(7, { allowLegacyReload: true })).status, 'manual_reload_required');
  assert.equal(forged.installs, 0); assert.deepEqual(forged.actions, []);
  const denied = fixture({ legacy: true }); denied.setPermitted(false);
  assert.equal((await denied.api.ensure(7, { allowLegacyReload: true })).reason, 'policy_not_authorized');
  assert.deepEqual(denied.actions, []);
  const stale = fixture({ legacy: true }); stale.setCurrent(false);
  assert.equal((await stale.api.ensure(7, { allowLegacyReload: true })).reason, 'policy_changed');
  assert.deepEqual(stale.actions, ['marker']);
});

test('navigation and removed ownership during worker authorization block final exact-document reload', async () => {
  const f = fixture({ legacy: true });
  f.setAuthorization(async () => { f.setDocument('document-two'); return {}; });
  assert.equal((await f.api.ensure(7, { allowLegacyReload: true })).status, 'manual_reload_required');
  assert.ok(!f.actions.includes('reload'));
  const g = fixture({ legacy: true });
  g.setAuthorization(async () => { g.page.__classpilotAuthGateBootstrap.active = false; return {}; });
  assert.equal((await g.api.ensure(7, { allowLegacyReload: true })).status, 'manual_reload_required');
  assert.ok(!g.actions.includes('reload'));
});

test('explicit frame-parent request requires extension top document and the same owned secure gate', async () => {
  const f = fixture({ ready: true });
  assert.equal((await f.api.requestReload({ ...f.sender, frameId: 1 })).reason, 'invalid_sender');
  assert.equal((await f.api.requestReload({ ...f.sender, id: 'page' })).reason, 'invalid_sender');
  assert.equal((await f.api.requestReload(f.sender)).status, 'reloaded');
  assert.deepEqual(f.actions, ['marker', 'reload']);
});

test('a later probe without owned gate removes the stale proof reference', async () => {
  const f = fixture({ ready: true });
  await f.api.ensure(7);
  assert.ok(f.page.__classpilotPageReloadProof?.gate);
  f.page.__classpilotAuthGateBootstrap.gateRoot.isConnected = false;
  await f.api.ensure(7);
  assert.equal(f.page.__classpilotPageReloadProof, undefined);
});

test('forget invalidates an outstanding transaction without allowing a concurrent replacement', async () => {
  const f = fixture({ legacy: true }), wait = deferred(), entered = deferred();
  f.setRead(async () => { entered.resolve(); return wait.promise; });
  const first = f.api.ensure(7, { allowLegacyReload: true }); await entered.promise;
  f.api.forgetTab(7);
  const second = f.api.ensure(7, { allowLegacyReload: true });
  wait.resolve({});
  assert.equal((await first).reason, 'operation_superseded');
  assert.equal((await second).reason, 'operation_superseded');
  assert.deepEqual(f.actions, []);
});

test('hung marker reads finish safely and pending writes block retries without late reload', async () => {
  const read = fixture({ legacy: true, timeoutMs: 8 }); read.setRead(() => new Promise(() => {}));
  assert.equal((await read.api.ensure(7, { allowLegacyReload: true })).reason, 'page_unavailable');
  read.setRead(null);
  assert.equal((await read.api.ensure(7, { allowLegacyReload: true })).status, 'reloaded');
  const write = fixture({ legacy: true, timeoutMs: 8 }), wait = deferred(); write.setWrite(() => wait.promise);
  assert.equal((await write.api.ensure(7, { allowLegacyReload: true })).reason, 'page_unavailable');
  assert.equal((await write.api.ensure(7, { allowLegacyReload: true })).reason, 'marker_write_pending');
  wait.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await write.api.ensure(7, { allowLegacyReload: true })).reason, 'already_attempted');
  assert.deepEqual(write.actions, ['marker']);
});
