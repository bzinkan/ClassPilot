import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { join } from 'node:path';

const source = readFileSync(process.env.CLASSPILOT_EXTENSION_PATH
  ? join(process.env.CLASSPILOT_EXTENSION_PATH, 'classroom-runtime-core.js')
  : new URL('../extension/classroom-runtime-core.js', import.meta.url), 'utf8');
const fixtureBytes = readFileSync(new URL('../server/__tests__/fixtures/classroom-focus-scope-cases.json', import.meta.url));
assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'),
  '4b04de889de92a89225d0e5b33bdf9d4f5b0ecce86c95cbe67d21b116bffa0f5',
  'The shared Classroom Focus contract fixture bytes changed');
const fixture = JSON.parse(fixtureBytes);
const sandbox = vm.createContext({ URL, TextEncoder });
vm.runInContext(source, sandbox);
const runtime = sandbox.ClassPilotRuntimeCore;
const plain = value => JSON.parse(JSON.stringify(value));
const scope = () => structuredClone(fixture.scope);
const state = (classroomScope = scope(), screenLock = {}) => ({ schemaVersion: 1, revision: 1,
  teachingSessionId: 'classroom-fixture', hardExpiresAt: Date.now() + 60_000,
  restrictions: { screenLock: { active: true, url: 'https://classroom.google.com/', classroomScope, ...screenLock },
    flightPath: { active: true, allowedDomains: ['retained.example'] } } });

test('Classroom Focus permits reviewed work/material scopes and rejects other destinations', () => {
  const normalized = runtime.normalizeClassroomState(state());
  for (const entry of fixture.match) {
    assert.equal(runtime.decideNavigation(entry.url, { classroomState: normalized }).allowed, entry.allowed, entry.name);
  }
  assert.deepEqual(plain(normalized.restrictions.screenLock.classroomScope), fixture.scope);
});

test('Classroom Focus remains beneath school/teacher blocks and separate authentication authority', () => {
  const input = state(); input.restrictions.blockList = { active: true, blockedDomains: ['assigned.example'] };
  const normalized = runtime.normalizeClassroomState(input);
  assert.equal(runtime.decideNavigation('https://assigned.example/work', { classroomState: normalized }).source, 'teacher');
  assert.equal(runtime.decideNavigation('https://docs.google.com/work', { classroomState: normalized, globalBlockedDomains: ['docs.google.com'] }).source, 'school');
});

test('invalid Classroom scopes reject the whole state instead of dropping selected materials', () => {
  const cases = [
    ['extra authority key', value => { value.extra = true; }],
    ['bad source revision', value => { value.sourceRevision = 'A'.repeat(64); }],
    ['bad schema', value => { value.schemaVersion = 2; }],
    ['missing work apps', value => { value.allowedDomains = ['classroom.google.com']; }],
    ['duplicate domain', value => { value.allowedDomains.push('assigned.example'); }],
    ['noncanonical domain', value => { value.allowedDomains.push('https://another.example'); }],
    ['malformed resource', value => { value.resources = [{}]; }],
    ['website masquerading as precise material', value => { value.resources = [{ type: 'website', hostname: 'other.example', includeSubdomains: true }]; }],
    ['YouTube section bypasses video identity', value => { value.resources = [{ type: 'section', hostname: 'youtube.com', includeSubdomains: false, pathPrefix: '/watch' }]; }],
    ['authentication section bypasses school SSO authority', value => { value.resources = [{ type: 'section', hostname: 'accounts.google.com', includeSubdomains: false, pathPrefix: '/signin' }]; }],
    ['combined entry overflow', value => { value.allowedDomains.push(...Array.from({ length: 193 }, (_, i) => `site-${i}.example`)); }],
  ];
  for (const [name, mutate] of cases) {
    const value = scope(); mutate(value);
    assert.throws(() => runtime.normalizeClassroomState(state(value)), { code: 'CLASSROOM_FOCUS_SCOPE_INVALID' }, name);
  }
  for (const lock of [
    { active: false }, { url: 'https://elsewhere.example/' },
    { url: 'https://classroom.google.com/?private=hint' },
    { url: 'https://classroom.google.com/#private' },
    { url: 'CURRENT_URL' }, { resource: fixture.scope.resources[0] },
  ]) assert.throws(() => runtime.normalizeClassroomState(state(scope(), lock)), undefined, JSON.stringify(lock));
});

test('Classroom Focus applies one combined serialized scope budget', () => {
  const value = scope(); value.resources = [];
  for (let i = 0; i < 192; i++) value.allowedDomains.push(`${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${String(i).padStart(3, '0')}${'d'.repeat(57)}.examplezz`);
  assert.equal(value.allowedDomains.length, 200);
  assert.ok(new TextEncoder().encode(JSON.stringify(value)).length > 49_152);
  assert.throws(() => runtime.normalizeClassroomState(state(value)), { code: 'CLASSROOM_FOCUS_SCOPE_INVALID' });
});

test('Classroom Focus has scoped native rules and preserves multiple approved material tabs', () => {
  const normalized = runtime.normalizeClassroomState(state());
  const rules = plain(runtime.buildDnrRules({ classroomState: normalized }, ['classroom']));
  assert.ok(rules.some(rule => rule.action.type === 'block' && rule.priority === 500));
  assert.ok(rules.some(rule => rule.condition.regexFilter && new RegExp(rule.condition.regexFilter).test('https://www.youtube.com/watch?v=dQw4w9WgXcQ')));
  const tabs = [{ id: 1, url: 'https://classroom.google.com/u/0/h', active: true },
    { id: 2, url: 'https://docs.google.com/document/d/student-copy/edit' },
    { id: 3, url: 'https://assigned.example/lesson?assignment=123' },
    { id: 4, url: 'https://unassigned.example/' }];
  const plan = runtime.planClassroomTabReconciliation(normalized, tabs, { foregroundTabId: 1 });
  assert.deepEqual(plain(plan.removeTabIds), [4]);
  assert.deepEqual(plain(plan.updates), []);
});

test('storage schema 4 requires its exact marker and a valid owned Classroom scope', () => {
  const persisted = { ...state(), schemaVersion: 4, classroomScopePersistenceVersion: 1 };
  const restored = runtime.normalizePersistedClassroomState(persisted);
  assert.deepEqual(plain(restored.restrictions.screenLock.classroomScope), fixture.scope);
  for (const invalid of [{ ...persisted, classroomScopePersistenceVersion: 2 },
    { ...persisted, schemaVersion: 1 },
    { ...persisted, schemaVersion: 2, precisePersistenceVersion: 1 },
    { ...persisted, restrictions: { screenLock: { active: false } } }]) {
    assert.throws(() => runtime.normalizePersistedClassroomState(invalid));
  }
});
