// GENERATED from src/services/screenshotDeltaCodec.ts; do not edit.
// Canonical SHA-256: 635e06c20d4112d1d184ecc31739bb3fe5b83db1232ad50faae56d6738dbf46f
(function attachClassPilotScreenshotDeltaCodec(root) {
'use strict';
/** Lossless JPEG-byte deltas. No pixels are decoded or re-encoded here. */
const SCREENSHOT_DELTA_CODEC = "cp-bit-copy-v1";
const MAX_SCREENSHOT_DELTA_BYTES = 256 * 1024;
const MAX_SCREENSHOT_DELTA_OPERATIONS = 8192;
const HEADER_BYTES = 12;
const MAX_INDEX_ENTRIES = 65536;
const MAX_CANDIDATES = 12;
const WINDOW_BYTES = 8;
const MIN_COPY_BYTES = 16;
const MAX_ENCODE_MS = 8;
const MIN_SAVINGS_BYTES = 512;
const MAGIC = [67, 80, 68, 49]; // CPD1; big-endian lengths and operands.
function isBytes(value) {
    return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]";
}
function full(reason) {
    return { kind: "full", reason };
}
/** Header: CPD1, base byte length, target byte length. Literal=0, bit-copy=1. */
function encodeScreenshotDelta(base, target, options = {}) {
    if (!isBytes(base) || !isBytes(target) || !base.length || !target.length
        || base.length > MAX_SCREENSHOT_DELTA_BYTES || target.length > MAX_SCREENSHOT_DELTA_BYTES)
        return full("bounds");
    if (target.length <= MIN_SAVINGS_BYTES)
        return full("not_profitable");
    if (!options || typeof options !== "object" || (options.now !== undefined && typeof options.now !== "function"))
        return full("options");
    const requestedBudget = options.budgetMs ?? MAX_ENCODE_MS;
    if (!Number.isFinite(requestedBudget) || requestedBudget < 0)
        return full("options");
    const budget = Math.min(MAX_ENCODE_MS, requestedBudget);
    const clock = options.now ?? (() => performance.now());
    let began;
    try {
        began = clock();
    }
    catch {
        return full("clock");
    }
    if (!Number.isFinite(began))
        return full("clock");
    let lastClock = began, badClock = false;
    const expired = () => {
        let value;
        try {
            value = clock();
        }
        catch {
            badClock = true;
            return true;
        }
        if (!Number.isFinite(value) || value < lastClock) {
            badClock = true;
            return true;
        }
        lastClock = value;
        return value - began >= budget;
    };
    const deadlineFallback = () => full(badClock ? "clock" : "budget");
    if (expired())
        return deadlineFallback();
    const shifted = [base];
    for (let shift = 1; shift < 8; shift++) {
        const value = new Uint8Array(base.length - 1);
        for (let index = 0; index < value.length; index++) {
            value[index] = (base[index] << shift) | (base[index + 1] >>> (8 - shift));
            if ((index & 1023) === 0 && expired())
                return deadlineFallback();
        }
        shifted.push(value);
    }
    const heads = new Int32Array(MAX_INDEX_ENTRIES);
    heads.fill(-1);
    const hashes = new Uint32Array(MAX_INDEX_ENTRIES), positions = new Uint32Array(MAX_INDEX_ENTRIES);
    const next = new Int32Array(MAX_INDEX_ENTRIES);
    const stride = Math.max(1, Math.ceil(8 * Math.max(0, base.length - WINDOW_BYTES + 1) / MAX_INDEX_ENTRIES));
    const prime = 257;
    let high = 1;
    for (let index = 1; index < WINDOW_BYTES; index++)
        high = Math.imul(high, prime) >>> 0;
    let entries = 0;
    for (let shift = 0; shift < shifted.length; shift++) {
        const value = shifted[shift];
        if (value.length < WINDOW_BYTES)
            continue;
        let hash = 0;
        for (let index = 0; index < WINDOW_BYTES; index++)
            hash = (Math.imul(hash, prime) + value[index]) >>> 0;
        for (let offset = 0; offset <= value.length - WINDOW_BYTES; offset++) {
            if (offset % stride === 0 && entries < MAX_INDEX_ENTRIES) {
                const bucket = hash & (MAX_INDEX_ENTRIES - 1);
                hashes[entries] = hash;
                positions[entries] = offset * 8 + shift;
                next[entries] = heads[bucket];
                heads[bucket] = entries++;
            }
            if ((offset & 1023) === 0 && expired())
                return deadlineFallback();
            if (offset + WINDOW_BYTES < value.length)
                hash = (Math.imul((hash - Math.imul(value[offset], high)) >>> 0, prime) + value[offset + WINDOW_BYTES]) >>> 0;
        }
    }
    const operations = [];
    let encodedLength = HEADER_BYTES, offset = 0, literalStart = 0, iterations = 0;
    const appendLiteral = (end) => {
        if (end <= literalStart)
            return;
        operations.push({ literal: true, start: literalStart, length: end - literalStart });
        encodedLength += 5 + end - literalStart;
    };
    while (offset + WINDOW_BYTES <= target.length) {
        if (((iterations++) & 63) === 0 && expired())
            return deadlineFallback();
        let hash = 0;
        for (let index = 0; index < WINDOW_BYTES; index++)
            hash = (Math.imul(hash, prime) + target[offset + index]) >>> 0;
        let candidate = heads[hash & (MAX_INDEX_ENTRIES - 1)], longest = 0, bitOffset = 0, considered = 0;
        while (candidate >= 0 && considered++ < MAX_CANDIDATES) {
            if (hashes[candidate] === hash) {
                const position = positions[candidate], from = position >>> 3, value = shifted[position & 7];
                const maximum = Math.min(value.length - from, target.length - offset);
                let length = 0;
                while (length < maximum && value[from + length] === target[offset + length]) {
                    length++;
                    if ((length & 1023) === 0 && expired())
                        return deadlineFallback();
                }
                if (length > longest) {
                    longest = length;
                    bitOffset = position;
                }
            }
            candidate = next[candidate];
        }
        if (longest >= MIN_COPY_BYTES) {
            appendLiteral(offset);
            operations.push({ literal: false, bitOffset, length: longest });
            encodedLength += 9;
            offset += longest;
            literalStart = offset;
            if (encodedLength > target.length * .75 || target.length - encodedLength < MIN_SAVINGS_BYTES)
                return full("not_profitable");
            if (operations.length > MAX_SCREENSHOT_DELTA_OPERATIONS)
                return full("operations");
        }
        else
            offset++;
    }
    appendLiteral(target.length);
    if (operations.length > MAX_SCREENSHOT_DELTA_OPERATIONS)
        return full("operations");
    if (encodedLength > target.length * .75 || target.length - encodedLength < MIN_SAVINGS_BYTES)
        return full("not_profitable");
    if (expired())
        return deadlineFallback();
    const encoded = new Uint8Array(encodedLength), view = new DataView(encoded.buffer);
    encoded.set(MAGIC);
    view.setUint32(4, base.length);
    view.setUint32(8, target.length);
    let cursor = HEADER_BYTES;
    for (const operation of operations) {
        encoded[cursor++] = operation.literal ? 0 : 1;
        if (operation.literal) {
            view.setUint32(cursor, operation.length);
            cursor += 4;
            encoded.set(target.subarray(operation.start, operation.start + operation.length), cursor);
            cursor += operation.length;
        }
        else {
            view.setUint32(cursor, operation.bitOffset);
            view.setUint32(cursor + 4, operation.length);
            cursor += 8;
        }
    }
    if (expired())
        return deadlineFallback();
    return { kind: "delta", bytes: encoded, targetBytes: target.length };
}
function invalid(reason) { throw new TypeError(`Invalid screenshot delta: ${reason}`); }
/** Bounded decode; integrity and exact authority/base IDs belong to the caller. */
function applyScreenshotDelta(base, patch) {
    if (!isBytes(base) || !isBytes(patch) || !base.length || base.length > MAX_SCREENSHOT_DELTA_BYTES
        || patch.length < HEADER_BYTES || patch.length > MAX_SCREENSHOT_DELTA_BYTES)
        return invalid("bounds");
    if (!MAGIC.every((value, index) => patch[index] === value))
        return invalid("magic");
    const view = new DataView(patch.buffer, patch.byteOffset, patch.byteLength);
    if (view.getUint32(4) !== base.length)
        return invalid("base length");
    const targetLength = view.getUint32(8);
    if (!targetLength || targetLength > MAX_SCREENSHOT_DELTA_BYTES)
        return invalid("target length");
    const output = new Uint8Array(targetLength);
    let cursor = HEADER_BYTES, written = 0, operations = 0;
    while (cursor < patch.length) {
        if (++operations > MAX_SCREENSHOT_DELTA_OPERATIONS)
            return invalid("operation limit");
        const opcode = patch[cursor++];
        if (opcode === 0) {
            if (cursor + 4 > patch.length)
                return invalid("literal header");
            const length = view.getUint32(cursor);
            cursor += 4;
            if (!length || length > targetLength - written || length > patch.length - cursor)
                return invalid("literal length");
            output.set(patch.subarray(cursor, cursor + length), written);
            cursor += length;
            written += length;
        }
        else if (opcode === 1) {
            if (cursor + 8 > patch.length)
                return invalid("copy header");
            const bitOffset = view.getUint32(cursor), length = view.getUint32(cursor + 4);
            cursor += 8;
            if (!length || length > targetLength - written || bitOffset + length * 8 > base.length * 8)
                return invalid("copy length");
            const from = bitOffset >>> 3, shift = bitOffset & 7;
            if (shift === 0)
                output.set(base.subarray(from, from + length), written);
            else
                for (let index = 0; index < length; index++)
                    output[written + index] = (base[from + index] << shift) | (base[from + index + 1] >>> (8 - shift));
            written += length;
        }
        else
            return invalid("opcode");
    }
    if (written !== targetLength)
        return invalid("target not filled");
    return output;
}

root.ClassPilotScreenshotDeltaCodec = Object.freeze({ SCREENSHOT_DELTA_CODEC, MAX_SCREENSHOT_DELTA_BYTES, MAX_SCREENSHOT_DELTA_OPERATIONS, encodeScreenshotDelta, applyScreenshotDelta });
})(globalThis);
