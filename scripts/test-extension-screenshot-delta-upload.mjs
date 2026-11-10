import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { resolve } from 'node:path';
const file = name => process.env.CLASSPILOT_EXTENSION_PATH ? resolve(process.env.CLASSPILOT_EXTENSION_PATH, name) : new URL('../extension/' + name, import.meta.url);
const worker = readFileSync(file('service-worker.js'), 'utf8').replaceAll('\r\n', '\n');
function declaration(name) {
    const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(worker);
    assert.ok(start, `production ${name} must exist`);
    const rest = worker.slice(start.index + start[0].length), end = /^}/m.exec(rest);
    return worker.slice(start.index, start.index + start[0].length + end.index + 1);
}
function image(seed = 1, length = 8192) {
    let s = seed;
    const b = Uint8Array.from({ length }, () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        return s & 255;
    });
    b.set([255, 216, 255]);
    return b;
}
const base = image(), next = base.slice();
next.fill(55, 800, 830);
const source = value => 'data:image/jpeg;base64,' + Buffer.from(value).toString('base64');
const auth = { authContextId: 'auth', mutationGeneration: 1, serverOrigin: 'https://school.invalid', schoolId: 'school', deviceId: 'device', studentId: 'student', studentSessionId: 'session' };
const firstId = '11111111-1111-4111-8111-111111111111', nextId = '22222222-2222-4222-8222-222222222222';
function fixture(crypto = webcrypto) {
    let enabled = true, current = true, policy = true;
    const calls = [], replies = [];
    const context = vm.createContext({ screenshotReferenceCache: null, Date, TextEncoder, Uint8Array, ArrayBuffer, DataView, performance, atob, btoa, crypto, setTimeout, clearTimeout,
        hasNegotiatedCapability: () => enabled, assertAuthenticatedContextCurrent() {
            if (!current)
                throw Object.assign(new Error('Synthetic auth change'), { code: 'AUTH_CONTEXT_SUPERSEDED' });
        },
        fetchWithBackoff: async (_url, init, options) => {
            await options.beforeAttempt?.();
            calls.push({ body: JSON.parse(init.body), options });
            return replies.shift() || new Response(JSON.stringify({ ok: true, retained: true, imageId: calls.length === 1 ? firstId : nextId }), { status: 200 });
        },
    });
    for (const name of ['screenshot-delta-codec.js', 'screenshot-references.js'])
        vm.runInContext(readFileSync(file(name), 'utf8'), context);
    for (const name of ['getScreenshotReferenceCache', 'prepareScreenshotImageCapture', 'screenshotDeltaTargetLimit', 'uploadRoutineScreenshot'])
        vm.runInContext(declaration(name), context);
    context.screenshotReferenceCache = context.ClassPilotScreenshotReferences.createCache({ encoderOptions: { now: () => 0 }, crypto });
    return { context, calls, replies, off() {
            enabled = false;
        }, retireAuth() {
            current = false;
        }, retirePolicy() {
            policy = false;
        },
        async upload(value = base, extra = {}) {
            const encoded = source(value), ticket = context.prepareScreenshotImageCapture(encoded, auth, 3, 'class:7/revision:2');
            return context.uploadRoutineScreenshot(auth.serverOrigin + '/api/classpilot/device/screenshot', { method: 'POST' }, { deviceTelemetry: { kind: 'screenshot', authContext: auth }, beforeAttempt() {
                    if (!policy)
                        throw Object.assign(new Error('Synthetic policy change'), { code: 'SCREENSHOT_POLICY_SUPERSEDED' });
                } }, { capturedAt: '2026-11-10T14:00:00.000Z', timestamp: Date.parse('2026-11-10T14:00:00.000Z'), screenshotAuthority: { kind: 'teaching_session', teachingSessionId: 'class', controlRevision: 2 }, ...extra }, encoded, ticket);
        },
    };
}
test('actual upload adapter sends scoped delta then recovers the exact same capture on a base miss', async () => {
    const f = fixture();
    await f.upload();
    f.replies.push(new Response('{"code":"SCREENSHOT_IMAGE_REQUIRED"}', { status: 409 }));
    await f.upload(next);
    assert.equal(f.calls.length, 3);
    assert.ok(f.calls[1].body.screenshotDelta);
    assert.equal(f.calls[1].body.screenshot, undefined);
    assert.equal(f.calls[2].body.screenshot, source(next));
    assert.equal(f.calls[2].body.screenshotDelta, undefined);
    assert.equal(f.calls[1].body.capturedAt, f.calls[2].body.capturedAt);
    assert.equal(f.calls[1].body.timestamp, f.calls[2].body.timestamp);
    assert.equal(f.calls[1].options.deviceTelemetry.logicalScreenshot, source(next));
});
test('auth and policy changes during asynchronous digest prevent any upload of stale pixels', async () => {
    for (const change of ['retireAuth', 'retirePolicy']) {
        let release, entered;
        const gate = new Promise(done => {
            release = done;
        }), begun = new Promise(done => {
            entered = done;
        });
        const crypto = { subtle: { digest: async (...args) => {
                    entered();
                    await gate;
                    return webcrypto.subtle.digest(...args);
                } } };
        const f = fixture(crypto);
        await f.upload();
        const pending = f.upload(next);
        await begun;
        f[change]();
        release();
        await assert.rejects(pending, error => ['AUTH_CONTEXT_SUPERSEDED', 'SCREENSHOT_POLICY_SUPERSEDED'].includes(error.code));
        assert.equal(f.calls.length, 1);
    }
});
test('capability rollback during digest sends a compatible full frame instead of delta', async () => {
    let release, entered;
    const gate = new Promise(done => {
        release = done;
    }), begun = new Promise(done => {
        entered = done;
    });
    const crypto = { subtle: { digest: async (...args) => {
                entered();
                await gate;
                return webcrypto.subtle.digest(...args);
            } } };
    const f = fixture(crypto);
    await f.upload();
    const pending = f.upload(next);
    await begun;
    f.off();
    release();
    await pending;
    assert.equal(f.calls[1].body.screenshot, source(next));
    assert.equal(f.calls[1].body.screenshotDelta, undefined);
});
test('conservative full-frame logical bound leaves oversized captures on the unchanged full path', async () => {
    const f = fixture();
    const large = image(9, 200000), changed = large.slice();
    changed.fill(55, 800, 830);
    await f.upload(large);
    await f.upload(changed);
    assert.equal(f.calls[1].body.screenshot, source(changed));
    assert.equal(f.calls[1].body.screenshotDelta, undefined);
});
