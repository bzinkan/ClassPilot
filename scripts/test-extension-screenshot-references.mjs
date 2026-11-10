import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { resolve } from 'node:path';

let source = '';
try { source = readFileSync(process.env.CLASSPILOT_EXTENSION_PATH
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH, 'screenshot-references.js')
  : new URL('../extension/screenshot-references.js', import.meta.url), 'utf8'); } catch { /* RED before implementation. */ }
const image = 'data:image/jpeg;base64,Zmlyc3Q=';
const changedImage = 'data:image/jpeg;base64,c2Vjb25k';
const imageId = 'opaque_image_1111111111111111111111';
function fixture() {
  const context = vm.createContext({}); vm.runInContext(source, context);
  assert.equal(typeof context.ClassPilotScreenshotReferences?.createCache, 'function');
  return context.ClassPilotScreenshotReferences.createCache();
}
const json = value => JSON.parse(JSON.stringify(value));

test('a fresh actual capture uses full bytes until the exact image was acknowledged', () => {
  const cache = fixture(); const first = cache.prepare(image, 'auth:A/class:1/revision:3');
  assert.deepEqual(json(first.body), { screenshot: image, screenshotImageProtocolVersion: 1 });
  const unacknowledged = cache.prepare(image, 'auth:A/class:1/revision:3');
  assert.deepEqual(json(unacknowledged.body), { screenshot: image, screenshotImageProtocolVersion: 1 });
  assert.equal(cache.accept(unacknowledged, { retained: true, imageId }), true);
  const repeat = cache.prepare(image, 'auth:A/class:1/revision:3');
  assert.deepEqual(json(repeat.body), { screenshotReferenceId: imageId, screenshotImageProtocolVersion: 1 });
});

test('moving pixels and every authority dimension change require full bytes', () => {
  for (const newScope of ['auth:B/class:1/revision:3', 'auth:A/class:2/revision:3', 'auth:A/class:1/revision:4']) {
    const cache = fixture(); cache.accept(cache.prepare(image, 'auth:A/class:1/revision:3'), { retained: true, imageId });
    assert.equal(cache.prepare(image, newScope).body.screenshot, image);
  }
  const cache = fixture(); cache.accept(cache.prepare(image, 'scope'), { retained: true, imageId });
  assert.equal(cache.prepare(changedImage, 'scope').body.screenshot, changedImage);
});

test('late acknowledgments cannot overwrite a newer capture or cross a cleared authority', () => {
  const cache = fixture(); const old = cache.prepare(image, 'scope'); const current = cache.prepare(changedImage, 'scope');
  assert.equal(cache.accept(current, { retained: true, imageId: 'opaque_image_2222222222222222222222' }), true);
  assert.equal(cache.accept(old, { retained: true, imageId }), false);
  assert.equal(cache.prepare(changedImage, 'scope').body.screenshotReferenceId, 'opaque_image_2222222222222222222222');
  const pending = cache.prepare(image, 'scope'); cache.clear();
  assert.equal(cache.accept(pending, { retained: true, imageId }), false);
  assert.equal(cache.prepare(image, 'scope').body.screenshot, image);
});

test('a cache miss resends the same capture bytes and invalidates the unusable reference', () => {
  const cache = fixture(); cache.accept(cache.prepare(image, 'scope'), { retained: true, imageId });
  const ticket = cache.prepare(image, 'scope');
  assert.deepEqual(json(cache.fullBody(ticket)), { screenshot: image, screenshotImageProtocolVersion: 1 });
  assert.equal(cache.prepare(image, 'scope').body.screenshot, image);
});

test('only retained valid opaque IDs establish reuse; oversized images keep full transfers', () => {
  for (const reply of [{ imageId, retained: false }, { imageId: '', retained: true }, { imageId: 'x', retained: true },
    { imageId: 'contains private / route', retained: true }, { retained: true }]) {
    const cache = fixture(); const ticket = cache.prepare(image, 'scope');
    assert.equal(cache.accept(ticket, reply), false);
    assert.equal(cache.prepare(image, 'scope').body.screenshot, image);
  }
  const cache = fixture(); const large = 'data:image/jpeg;base64,' + 'x'.repeat(2 * 1024 * 1024);
  assert.equal(cache.accept(cache.prepare(large, 'scope'), { retained: true, imageId }), false);
  assert.equal(cache.prepare(large, 'scope').body.screenshot, large);
});

test('clear revokes full-frame recovery for a retired capture', () => {
  const cache = fixture(); const ticket = cache.prepare(image, 'scope'); cache.clear();
  assert.throws(() => cache.fullBody(ticket), error => error.code === 'SCREENSHOT_POLICY_SUPERSEDED');
});
