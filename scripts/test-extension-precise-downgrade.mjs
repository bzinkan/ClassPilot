import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const receipt = JSON.parse(readFileSync(join(root, 'scripts/fixtures/auth-recovery-2.9.5.json')));
const archive = readFileSync(join(root, 'scripts/fixtures/auth-recovery-2.9.5.json.gz'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha256(archive), receipt.archiveSha256);
const oldSource = JSON.parse(gunzipSync(archive)).files['classroom-runtime-core.js'];
assert.equal(sha256(oldSource), receipt.files['classroom-runtime-core.js']);
const extension = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const currentSource = readFileSync(join(extension, 'classroom-runtime-core.js'), 'utf8');
function load(source) {
  const context = { URL, Date, TextEncoder };
  runInNewContext(source, context);
  return context.ClassPilotRuntimeCore;
}
const old = load(oldSource), current = load(currentSource);
const resource = JSON.parse(readFileSync(join(root, 'server/__tests__/fixtures/restriction-resource-matcher-cases.json'))).resources.googleDoc;
const otherDocument = 'https://docs.google.com/document/d/DifferentSyntheticDocumentId0123456789/edit';
const now = Date.now();
const wire = { schemaVersion: 1, revision: 1, teachingSessionId: 'synthetic-class',
  hardExpiresAt: now + 60_000, restrictions: { screenLock: {
    active: true, url: resource.canonicalUrl, domain: 'docs.google.com', resource } } };
const persisted = { ...wire, schemaVersion: 2, precisePersistenceVersion: 1 };

test('released 2.9.5 refuses the storage-only schema instead of widening a precise Waypoint', () => {
  // Establish why the storage fence is necessary using the unmodified receipt.
  const oldWire = old.normalizeClassroomState(wire, now);
  assert.equal(old.isRestrictionDestinationUrl(oldWire, otherDocument), true);
  assert.throws(() => old.normalizeClassroomState(persisted, now), /schema/i);
  const restored = current.normalizePersistedClassroomState(persisted, now);
  assert.equal(current.isRestrictionDestinationUrl(restored, resource.canonicalUrl), true);
  assert.equal(current.isRestrictionDestinationUrl(restored, otherDocument), false);
});

test('wire delivery cannot use the storage schema and corrupt storage cannot drop precision', () => {
  assert.throws(() => current.normalizeClassroomState(persisted, now), /schema/i);
  assert.throws(() => current.normalizePersistedClassroomState({ ...persisted, precisePersistenceVersion: 2 }, now));
  assert.throws(() => current.normalizePersistedClassroomState({ ...persisted,
    restrictions: { screenLock: { active: true, url: resource.canonicalUrl, domain: 'docs.google.com' } } }, now));
});
