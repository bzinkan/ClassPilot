import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { resolve } from 'node:path';
const file = name => process.env.CLASSPILOT_EXTENSION_PATH ? resolve(process.env.CLASSPILOT_EXTENSION_PATH, name) : new URL('../extension/' + name, import.meta.url);
const references = readFileSync(file('screenshot-references.js'), 'utf8'), codec = readFileSync(file('screenshot-delta-codec.js'), 'utf8');
const imageId = '11111111-1111-4111-8111-111111111111';
function pixels(seed = 1) {
    let state = seed;
    const out = Uint8Array.from({ length: 8192 }, () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state & 255;
    });
    out.set([255, 216, 255]);
    out.set([255, 217], out.length - 2);
    return out;
}
const base = pixels(), target = base.slice();
target.fill(85, 1500, 1540);
const source = bytes => 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64');
function fixture(options = {}) {
    const context = vm.createContext({ performance, TextEncoder, Uint8Array, ArrayBuffer, DataView, atob, btoa, setTimeout, clearTimeout, crypto: options.crypto || webcrypto });
    vm.runInContext(codec, context);
    vm.runInContext(references, context);
    const cache = context.ClassPilotScreenshotReferences.createCache({ encoderOptions: { now: () => 0 }, ...options });
    assert.equal(typeof cache.prepareAsync, 'function', 'Image cache must support scoped asynchronous delta preparation');
    return { cache, codec: context.ClassPilotScreenshotDeltaCodec };
}
const json = value => JSON.parse(JSON.stringify(value));
function acknowledge(cache) {
    const ticket = cache.prepare(source(base), 'scope');
    assert.equal(cache.accept(ticket, { retained: true, imageId }), true);
}
test('delta capture reuses only one acknowledged exact-scope base and verifies upload integrity', async () => {
    const { cache, codec } = fixture();
    acknowledge(cache);
    const ticket = await cache.prepareAsync(source(target), 'scope', { allowDelta: true, maxTargetBytes: 8192 });
    const delta = ticket.body.screenshotDelta;
    assert.equal(delta.codec, 'cp-bit-copy-v1');
    assert.equal(delta.baseImageId, imageId);
    assert.equal(delta.targetBytes, target.length);
    assert.equal(ticket.body.screenshot, undefined);
    assert.equal(ticket.body.screenshotReferenceId, undefined);
    assert.equal(ticket.body.screenshotImageProtocolVersion, 1);
    assert.deepEqual(Array.from(codec.applyScreenshotDelta(base, Uint8Array.from(Buffer.from(delta.data, 'base64')))), Array.from(target));
    assert.equal(delta.uploadIntegrity, createHash('sha256').update('classpilot:screenshot-delta-upload:v1\0' + imageId + '\0').update(target).digest('hex'));
});
test('exact-image references win without hashing and disabled deltas retain full transfers', async () => {
    const { cache } = fixture({ crypto: { subtle: { digest() {
                    throw new Error('Must not hash reference');
                } } } });
    acknowledge(cache);
    const exact = await cache.prepareAsync(source(base), 'scope', { allowDelta: true });
    assert.equal(exact.body.screenshotReferenceId, imageId);
    const off = await cache.prepareAsync(source(target), 'scope', { allowDelta: false });
    assert.equal(off.body.screenshot, source(target));
});
test('every scope change and unacknowledged frame uses full pixels', async () => {
    const { cache } = fixture();
    assert.equal((await cache.prepareAsync(source(target), 'scope', { allowDelta: true })).body.screenshot, source(target));
    acknowledge(cache);
    assert.equal((await cache.prepareAsync(source(target), 'other-scope', { allowDelta: true })).body.screenshot, source(target));
});
test('oversized logical targets, deadlines and nonprofitable content fall back to the same full capture', async () => {
    for (const options of [{ maxTargetBytes: 8191 }, { encoderOptions: { budgetMs: 0 } }]) {
        const { cache } = fixture();
        acknowledge(cache);
        const ticket = await cache.prepareAsync(source(target), 'scope', { allowDelta: true, ...options });
        assert.equal(ticket.body.screenshot, source(target));
        assert.equal(ticket.body.screenshotDelta, undefined);
    }
    const { cache } = fixture();
    acknowledge(cache);
    assert.equal((await cache.prepareAsync(source(pixels(7)), 'scope', { allowDelta: true })).body.screenshot, source(pixels(7)));
});
test('digest errors keep the current genuine capture available for full recovery', async () => {
    const { cache } = fixture({ crypto: { subtle: { digest: async () => {
                    throw new Error('Synthetic digest failure');
                } } } });
    acknowledge(cache);
    const ticket = await cache.prepareAsync(source(target), 'scope', { allowDelta: true });
    assert.equal(ticket.body.screenshot, source(target));
    assert.deepEqual(json(cache.fullBody(ticket)), { screenshot: source(target), screenshotImageProtocolVersion: 1 });
});
test('a stalled digest falls back through a bounded timer without a late delta publication', async () => {
    let release, expire;
    const gate = new Promise(done => {
        release = done;
    });
    const crypto = { subtle: { digest: async (...args) => {
                await gate;
                return webcrypto.subtle.digest(...args);
            } } };
    const { cache } = fixture({ crypto, setTimeout(fn) {
            expire = fn;
            return 1;
        }, clearTimeout() {
        } });
    acknowledge(cache);
    const pending = cache.prepareAsync(source(target), 'scope', { allowDelta: true });
    try {
        assert.equal(typeof expire, 'function');
        expire();
        const ticket = await pending;
        assert.equal(ticket.body.screenshot, source(target));
    }
    finally {
        release();
        await pending;
    }
});
test('clear or a newer capture during digest retires pending deltas and late acknowledgments', async () => {
    for (const replacement of ['clear', 'new']) {
        let release;
        const gate = new Promise(done => {
            release = done;
        });
        let entered;
        const begun = new Promise(done => {
            entered = done;
        });
        const crypto = { subtle: { digest: async (...args) => {
                    entered();
                    await gate;
                    return webcrypto.subtle.digest(...args);
                } } };
        const { cache } = fixture({ crypto });
        acknowledge(cache);
        const pending = cache.prepareAsync(source(target), 'scope', { allowDelta: true });
        await begun;
        if (replacement === 'clear')
            cache.clear();
        else
            cache.prepare(source(pixels(9)), 'scope');
        release();
        await assert.rejects(pending, error => error.code === 'SCREENSHOT_POLICY_SUPERSEDED');
        assert.equal(cache.prepare(source(target), 'new-scope').body.screenshot, source(target));
    }
});
test('delta miss fullBody uses exactly the original capture and accepts only its current receipt', async () => {
    const { cache } = fixture();
    acknowledge(cache);
    const ticket = await cache.prepareAsync(source(target), 'scope', { allowDelta: true });
    assert.ok(ticket.body.screenshotDelta);
    assert.equal(cache.fullBody(ticket).screenshot, source(target));
    assert.equal(cache.accept(ticket, { retained: true, imageId: '22222222-2222-4222-8222-222222222222' }), true);
    assert.equal(cache.prepare(source(target), 'scope').body.screenshotReferenceId, '22222222-2222-4222-8222-222222222222');
});
