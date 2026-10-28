import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const source = readFileSync(join(extension, 'service-worker.js'), 'utf8');
function between(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `actual worker section ${start}`);
  return source.slice(from, to);
}

function fixture() {
  const auth = { serverOrigin: 'https://synthetic.example.test', schoolId: 'school-a', deviceId: 'device-a',
    studentId: 'student-a', studentSessionId: 'login-a', authContextId: 'auth-a' };
  const stored = {}, removed = [];
  let tabs = [{ id: 101, url: 'https://littlealchemy.com/', title: 'Little Alchemy' },
    { id: 102, url: 'https://example.test/classwork', title: 'Classwork' }];
  let tabRef = 0;
  const c = {
    URL, URLSearchParams, TextEncoder, console, Date,
    CONFIG: { schoolId: auth.schoolId, deviceId: auth.deviceId, activeStudentId: auth.studentId,
      activeStudentSessionId: auth.studentSessionId },
    studentAuthInvalidating: false, supervisionCommandAuthority: null,
    studentControlRevisionAuthority: { scope: JSON.stringify(Object.values(auth)), revision: 8 },
    currentClassroomState: null, currentFabState: null,
    captureAuthenticatedContext: () => auth,
    assertAuthenticatedContextCurrent: context => { assert.equal(context.authContextId, auth.authContextId); return context; },
    normalizeIdList: values => [...new Set((Array.isArray(values) ? values : []).filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()))],
    hasNegotiatedCapability: name => ['scheduledClassroomV1', 'exactTabCloseV2'].includes(name),
    fabIdentityBinding: () => `v3:${auth.authContextId}`, browserPolicyEnvelopeForAuth: () => ({}),
    clearClassroomOverlayState: async () => {}, focusAssignment: null, deferredTeacherMessageNotification: null,
    attentionModeActive: false, FAB_STATE_STORAGE_KEY: 'fab', FAB_CONTEXT_STORAGE_KEY: 'context',
    FAB_CHAT_CONTEXT_STORAGE_KEY: 'chat', TAB_SNAPSHOT_STORAGE_KEY: 'snapshot',
    kv: { get: async () => stored, set: async value => Object.assign(stored, value) },
    AUTHORITY_BOUND_COMMAND_TYPES: new Set(['close-tab', 'close-tabs', 'timer', 'student-sign-out']),
    tabSnapshotMutation: Promise.resolve(), currentTabSnapshotRevision: 0, retiredFocusTabRefs: new Set(),
    isHttpUrl: value => /^https?:/.test(value || ''), tabSnapshotAuthBinding: () => `tabs:${auth.authContextId}`,
    hasSessionStorage: () => false, snapshotFaviconUrl: value => value || '', generateOpaqueTabRef: () => `opaque-${++tabRef}`,
    isAuthContextCancellation: () => false,
    chrome: { tabs: { query: async () => tabs.map(tab => ({ ...tab })),
      get: async id => { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('No synthetic tab'); return { ...tab }; },
      remove: async id => { removed.push(id); tabs = tabs.filter(tab => tab.id !== id); } } },
  };
  createContext(c);
  runInContext(readFileSync(join(extension, 'classroom-runtime-core.js'), 'utf8'), c);
  c.RuntimeCore = c.ClassPilotRuntimeCore;
  c.restrictionSafeMonitoringMetadata = tab => c.RuntimeCore.restrictionSafeMonitoringMetadata(c.currentClassroomState, tab);
  for (const code of [
    between('function exactStudentBinding(', '\nfunction schoolPolicyScope('),
    between('function observeStudentControlRevision(', '\nfunction assertChromeProfileRegistrationAllowed('),
    between('function assertBindingMatchesAuthContext(', '\nfunction adoptNegotiatedProtocolState('),
    between('function scheduledContextAuthorityRevision(', '\nlet fabStateMutation'),
    between('async function applyFabSettingsNow(', '\nfunction applyFabSettings('),
    between('function activeTeachingSessionIds(', '\nfunction activeClassroomContexts('),
    between('function commandAuthority(', '\nchrome.notifications?.onClosed?'),
    between('function buildOpaqueTabSnapshot(', '\nfunction setObservedState('),
  ]) runInContext(code, c);
  const binding = (revision = 8, override = {}) => ({ bindingVersion: 2, schoolId: auth.schoolId,
    deviceId: auth.deviceId, studentId: auth.studentId, studentSessionId: auth.studentSessionId,
    controlRevision: revision, ...override });
  const envelope = (revision = 8, override = {}) => ({ exactBinding: binding(revision, override) });
  const fab = (revision = 8, override = {}) => ({ schemaVersion: 1, revision: 1, ownershipRevision: revision,
    studentId: auth.studentId, studentSessionId: auth.studentSessionId, teachingSessionId: null,
    supervisionContextId: 'supervision-a', contextAuthorityRevision: '2',
    activeContexts: [{ supervisionContextId: 'supervision-a' }], activeSessionIds: [],
    supervisionContext: { id: 'supervision-a', contextAuthorityRevision: '2', endsAt: new Date(Date.now() + 60_000).toISOString() },
    ...override });
  const apply = (payload = fab(), frame = envelope()) => c.applyFabSettingsNow(payload,
    { authContext: auth, authorityEnvelope: frame, broadcast: false });
  const command = { type: 'close-tab', authority: { supervisionContextId: 'supervision-a' } };
  const authorize = (frame = envelope()) => c.assertCurrentCommandAuthority(command, frame);
  return { c, auth, fab, binding, envelope, apply, authorize, removed, getTabs: () => tabs };
}

test('fresh exact-bound supervision metadata permits only the selected close while restrictions remain withheld', async () => {
  const f = fixture();
  assert.throws(() => f.authorize(), /inactive supervision context/);
  await f.apply();
  assert.equal(f.c.currentClassroomState, null, 'FAB permission never fabricates applied restrictions');
  assert.equal(f.authorize().supervisionContextId, 'supervision-a');
  const snapshot = await f.c.buildOpaqueTabSnapshot(f.getTabs(), f.auth);
  const selected = snapshot.tabs.find(tab => tab.url === 'https://littlealchemy.com/');
  const exact = await f.c.resolveExactTabRefs([selected.tabRef], snapshot.revision, f.auth);
  await f.c.closeExactTabTargets(exact, f.auth);
  assert.deepEqual(f.removed, [101]);
  assert.equal(f.getTabs().length, 1);
  assert.equal(f.getTabs()[0].id, 102);
  assert.equal(f.c.currentClassroomState, null);
});

test('stale revisions and other school/device/student/session bindings cannot authorize a close', async () => {
  const f = fixture(); await f.apply();
  for (const frame of [f.envelope(7), f.envelope(8, { schoolId: 'other' }), f.envelope(8, { deviceId: 'other' }),
    f.envelope(8, { studentId: 'other' }), f.envelope(8, { studentSessionId: 'other' }),
    { studentId: f.auth.studentId, studentSessionId: f.auth.studentSessionId }]) {
    assert.throws(() => f.authorize(frame), /inactive supervision context/);
  }
  f.c.observeStudentControlRevision(9, f.auth);
  assert.throws(() => f.authorize(), /inactive supervision context/);
  assert.equal(f.removed.length, 0);
});

test('incomplete, expired, ambiguous or incorrectly bound FAB metadata grants no command authority', async () => {
  for (const override of [
    { supervisionContext: undefined }, { supervisionContext: { id: 'supervision-a', endsAt: Date.now() + 60_000 } },
    { supervisionContext: { id: 'wrong', contextAuthorityRevision: '2', endsAt: Date.now() + 60_000 } },
    { supervisionContext: { id: 'supervision-a', contextAuthorityRevision: '1', endsAt: Date.now() + 60_000 } },
    { supervisionContext: { id: 'supervision-a', contextAuthorityRevision: '2', endsAt: Date.now() - 1 } },
    { activeContexts: [{ supervisionContextId: 'supervision-a' }, { supervisionContextId: 'other' }] },
  ]) {
    const f = fixture(); await f.apply(f.fab(8, override));
    assert.throws(() => f.authorize(), /inactive supervision context/);
  }
  const f = fixture();
  await assert.rejects(f.apply(f.fab(), f.envelope(8, { deviceId: 'other' })), /authentication context/);
  assert.throws(() => f.authorize(), /inactive supervision context/);
});

test('ended supervision stays retired when a delayed same-revision FAB arrives', async () => {
  const f = fixture(); await f.apply();
  f.c.retireSupervisionCommandAuthority({ ...f.envelope(), supervisionContextId: 'supervision-a' }, f.auth);
  assert.throws(() => f.authorize(), /inactive supervision context/);
  await f.apply();
  assert.throws(() => f.authorize(), /inactive supervision context/);
  await f.apply(f.fab(8, { contextAuthorityRevision: '3',
    supervisionContext: { id: 'supervision-a', contextAuthorityRevision: '3', endsAt: Date.now() + 60_000 } }));
  assert.throws(() => f.authorize(), /inactive supervision context/);
  await f.apply(f.fab(9), f.envelope(9));
  assert.equal(f.authorize(f.envelope(9)).supervisionContextId, 'supervision-a');
  f.c.retireSupervisionCommandAuthority({ ...f.envelope(8), supervisionContextId: 'supervision-a' }, f.auth);
  f.c.retireSupervisionCommandAuthority({ ...f.envelope(9), supervisionContextId: 'unrelated-context' }, f.auth);
  assert.equal(f.authorize(f.envelope(9)).supervisionContextId, 'supervision-a');
});

test('metadata expiry, capability loss, auth change and a conflicting restriction owner remain fences', async () => {
  const f = fixture(); await f.apply();
  f.c.supervisionCommandAuthority = { ...f.c.supervisionCommandAuthority, endsAt: Date.now() - 1 };
  assert.throws(() => f.authorize(), /inactive supervision context/);
  const other = fixture(); await other.apply();
  other.c.currentClassroomState = other.c.RuntimeCore.normalizeClassroomState({ schemaVersion: 1, revision: 7,
    teachingSessionId: 'different-owner', hardExpiresAt: Date.now() + 60_000, restrictions: {} });
  assert.throws(() => other.authorize(), /inactive supervision context/);
  other.c.currentClassroomState = null;
  other.c.hasNegotiatedCapability = () => false;
  assert.throws(() => other.authorize(), /inactive supervision context/);
  other.c.hasNegotiatedCapability = () => true;
  other.auth.authContextId = 'new-auth';
  assert.throws(() => other.authorize(), /inactive supervision context/);
});

test('a verified ownership clear revokes authority and a worker restart requires fresh metadata', async () => {
  const f = fixture(); await f.apply();
  await f.apply(f.fab(9, { supervisionContextId: null, contextAuthorityRevision: null,
    supervisionContext: undefined, activeContexts: [], activeSessionIds: [] }), f.envelope(9));
  assert.throws(() => f.authorize(f.envelope(9)), /inactive supervision context/);
  await f.apply(f.fab(8), f.envelope(8));
  assert.throws(() => f.authorize(f.envelope(9)), /inactive supervision context/);
  const restarted = fixture(); await restarted.apply();
  restarted.c.supervisionCommandAuthority = null;
  assert.throws(() => restarted.authorize(), /inactive supervision context/);
  await restarted.apply();
  assert.equal(restarted.authorize().supervisionContextId, 'supervision-a');
});
