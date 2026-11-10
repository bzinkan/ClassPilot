import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { resolve } from 'node:path';

const extensionFile = name => process.env.CLASSPILOT_EXTENSION_PATH
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH, name) : new URL('../extension/' + name, import.meta.url);
const worker = readFileSync(extensionFile('service-worker.js'), 'utf8').replace(/\r\n/g, '\n');
const moduleSource = readFileSync(extensionFile('screenshot-references.js'), 'utf8');
function declaration(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(worker);
  assert.ok(start, `production ${name} must exist`);
  const remaining = worker.slice(start.index + start[0].length); const end = /^}/m.exec(remaining);
  return worker.slice(start.index, start.index + start[0].length + end.index + 1);
}
const image = 'data:image/jpeg;base64,Zmlyc3Q=';
const imageId = 'opaque_image_1111111111111111111111';
const auth = { authContextId: 'auth', mutationGeneration: 4, serverOrigin: 'https://school.invalid', schoolId: 'school', deviceId: 'device', studentId: 'student', studentSessionId: 'session' };
function fixture() {
  let enabled = true; const calls = [], replies = [];
  const context = vm.createContext({ screenshotReferenceCache: null, Date,
    hasNegotiatedCapability: () => enabled,
    fetchWithBackoff: async (_url, init, options) => {
      await options.beforeAttempt?.();
      calls.push(JSON.parse(init.body));
      return replies.shift() || new Response(JSON.stringify({ ok: true, retained: true, imageId }), { status: 200 });
    },
  });
  vm.runInContext(moduleSource, context);
  for (const name of ['getScreenshotReferenceCache', 'prepareScreenshotImageCapture', 'uploadRoutineScreenshot']) vm.runInContext(declaration(name), context);
  return { context, calls, replies,
    disable() { enabled = false; },
    prepare(scope = 'teaching:1/revision:3', currentAuth = auth, generation = 9) {
      return context.prepareScreenshotImageCapture(image, currentAuth, generation, scope);
    },
    async upload(ticket, capturedAt = '2026-11-09T14:00:00.000Z', options = {}) {
      return context.uploadRoutineScreenshot(auth.serverOrigin + '/api/device/screenshot', { method: 'POST' }, options,
        { capturedAt, timestamp: Date.parse(capturedAt), tabTitle: 'Lesson', screenshotAuthority: { kind: 'teaching_session', teachingSessionId: 'class', controlRevision: 3 } }, image, ticket);
    },
  };
}

test('negotiated fresh captures reuse only the last acknowledged exact-scope pixels with fresh metadata', async () => {
  const f = fixture(); await f.upload(f.prepare());
  const next = f.prepare(); assert.equal(next.body.screenshotReferenceId, imageId);
  await f.upload(next, '2026-11-09T14:00:05.000Z');
  assert.equal(f.calls[1].screenshot, undefined); assert.equal(f.calls[1].screenshotReferenceId, imageId);
  assert.equal(f.calls[1].capturedAt, '2026-11-09T14:00:05.000Z'); assert.equal(f.calls[1].tabTitle, 'Lesson');
});

test('reference miss retries the original fresh capture once before generic authority-denial handling', async () => {
  const f = fixture(); await f.upload(f.prepare());
  f.replies.push(new Response('{"code":"SCREENSHOT_IMAGE_REQUIRED"}', { status: 409 }));
  const outcome = await f.upload(f.prepare(), '2026-11-09T14:00:05.000Z');
  assert.equal(outcome.response.status, 200); assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1].screenshotReferenceId, imageId);
  assert.equal(f.calls[2].screenshotReferenceId, undefined); assert.equal(f.calls[2].screenshot, image);
  assert.equal(f.calls[1].capturedAt, f.calls[2].capturedAt);
  assert.equal(f.calls[1].timestamp, f.calls[2].timestamp);
});

test('authority changes before full-frame retry cancel the stale image', async () => {
  const f = fixture(); await f.upload(f.prepare());
  f.replies.push(new Response('{"code":"SCREENSHOT_IMAGE_REQUIRED"}', { status: 409 }));
  const original = f.context.fetchWithBackoff;
  f.context.fetchWithBackoff = async (...args) => { const response = await original(...args); f.context.getScreenshotReferenceCache().clear(); return response; };
  await assert.rejects(f.upload(f.prepare()), error => error.code === 'SCREENSHOT_POLICY_SUPERSEDED');
  assert.equal(f.calls.length, 2);
});

test('disabling negotiation, changing auth or control generation discards old references', async () => {
  const f = fixture(); await f.upload(f.prepare());
  assert.equal(f.prepare('teaching:1/revision:3', { ...auth, studentSessionId: 'replacement' }).body.screenshot, image);
  await f.upload(f.prepare());
  assert.equal(f.prepare('teaching:1/revision:3', auth, 10).body.screenshot, image);
  await f.upload(f.prepare()); f.disable();
  assert.equal(f.prepare(), null);
  const result = await f.upload(null);
  assert.equal(result.response.status, 200); assert.equal(f.calls.at(-1).screenshot, image);
  assert.equal(f.calls.at(-1).screenshotImageProtocolVersion, undefined);
});

test('an unrelated 409 stays a denial and cannot trigger an image retry', async () => {
  const f = fixture(); await f.upload(f.prepare());
  f.replies.push(new Response('{"code":"SCREENSHOT_AUTHORITY_SUPERSEDED"}', { status: 409 }));
  const result = await f.upload(f.prepare());
  assert.equal(result.response.status, 409); assert.equal(f.calls.length, 2);
});
