(function attachClassPilotScreenshotReferences(root) {
  'use strict';
  const MAX_CACHED_SOURCE_LENGTH = 2 * 1024 * 1024;
  const OPAQUE_IMAGE_ID = /^[A-Za-z0-9_-]{16,128}$/;

  // One acknowledged image and the current actual capture, in memory only.
  // The caller creates a ticket only AFTER fresh capture/encoding and supplies
  // the exact auth + screenshot authority scope. This never schedules captures
  // or manufactures freshness from a heartbeat/reference lookup.
  function createCache(options = {}) {
    let acknowledged = null;
    let current = null;

    function clear() { acknowledged = null; current = null; }

    function prepare(source, scope) {
      if (typeof source !== 'string' || !source || typeof scope !== 'string' || !scope || scope.length > 2048) {
        throw new TypeError('A screenshot capture and exact scope are required');
      }
      if (acknowledged?.scope !== scope) acknowledged = null;
      const referenceId = acknowledged?.source === source ? acknowledged.imageId : null;
      current = Object.freeze({ source, scope, body: Object.freeze(referenceId
        ? { screenshotReferenceId: referenceId, screenshotImageProtocolVersion: 1 }
        : { screenshot: source, screenshotImageProtocolVersion: 1 }) });
      return current;
    }

    function retired() {
      const error = new Error('Screenshot capture belongs to a retired authority');
      error.code = 'SCREENSHOT_POLICY_SUPERSEDED';
      return error;
    }

    function jpegBytes(source, limit) {
      const prefix = 'data:image/jpeg;base64,';
      if (!source.startsWith(prefix)) return null;
      const encoded = source.slice(prefix.length);
      if (!encoded || encoded.length > Math.ceil(limit / 3) * 4
        || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
      const binary = atob(encoded);
      if (binary.length > limit || btoa(binary) !== encoded) return null;
      const bytes = Uint8Array.from(binary, value => value.charCodeAt(0));
      return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? bytes : null;
    }

    async function prepareAsync(source, scope, settings = {}) {
      const ticket = prepare(source, scope);
      if (ticket.body.screenshotReferenceId || settings.allowDelta !== true) return ticket;
      const base = acknowledged, codec = options.codec || root.ClassPilotScreenshotDeltaCodec;
      if (!base || base.scope !== scope || typeof codec?.encodeScreenshotDelta !== 'function') return ticket;
      const alive = () => { if (current !== ticket || acknowledged !== base) throw retired(); };
      try {
        const maximum = settings.maxTargetBytes ?? codec.MAX_SCREENSHOT_DELTA_BYTES;
        if (!Number.isInteger(maximum) || maximum <= 0) return ticket;
        const target = jpegBytes(source, Math.min(codec.MAX_SCREENSHOT_DELTA_BYTES, maximum));
        if (!target) return ticket;
        if (!base.bytes) base.bytes = jpegBytes(base.source, codec.MAX_SCREENSHOT_DELTA_BYTES);
        if (!base.bytes) return ticket;
        const delta = codec.encodeScreenshotDelta(base.bytes, target, settings.encoderOptions || options.encoderOptions);
        if (delta.kind !== 'delta') return ticket;
        const prefix = new TextEncoder().encode('classpilot:screenshot-delta-upload:v1\0' + base.imageId + '\0');
        const integrityInput = new Uint8Array(prefix.length + target.length);
        integrityInput.set(prefix); integrityInput.set(target, prefix.length);
        const provider = options.crypto || root.crypto;
        const schedule = options.setTimeout || root.setTimeout;
        const cancel = options.clearTimeout || root.clearTimeout;
        let deadline;
        const digest = new Uint8Array(await Promise.race([
          provider.subtle.digest('SHA-256', integrityInput),
          new Promise((_, reject) => { deadline = schedule(() => reject(new Error('Screenshot digest deadline')), 100); }),
        ]).finally(() => cancel(deadline)));
        alive();
        let patch = '';
        for (let offset = 0; offset < delta.bytes.length; offset += 0x8000) {
          patch += String.fromCharCode(...delta.bytes.subarray(offset, offset + 0x8000));
        }
        current = Object.freeze({ source, scope, body: Object.freeze({
          screenshotImageProtocolVersion: 1,
          screenshotDelta: Object.freeze({ codec: codec.SCREENSHOT_DELTA_CODEC, baseImageId: base.imageId,
            data: btoa(patch), targetBytes: target.length,
            uploadIntegrity: Array.from(digest, value => value.toString(16).padStart(2, '0')).join('') }),
        }) });
        return current;
      } catch (error) {
        alive();
        if (error?.code === 'SCREENSHOT_POLICY_SUPERSEDED') throw error;
        return ticket;
      }
    }

    function accept(ticket, response) {
      if (ticket !== current) return false;
      if (response?.retained !== true || typeof response.imageId !== 'string'
        || !OPAQUE_IMAGE_ID.test(response.imageId) || ticket.source.length > MAX_CACHED_SOURCE_LENGTH) {
        acknowledged = null;
        return false;
      }
      acknowledged = { scope: ticket.scope, source: ticket.source, imageId: response.imageId };
      return true;
    }

    function fullBody(ticket) {
      if (ticket !== current) {
        const error = new Error('Screenshot capture belongs to a retired authority');
        error.code = 'SCREENSHOT_POLICY_SUPERSEDED';
        throw error;
      }
      acknowledged = null;
      return { screenshot: ticket.source, screenshotImageProtocolVersion: 1 };
    }

    return Object.freeze({ prepare, prepareAsync, accept, fullBody, clear });
  }

  root.ClassPilotScreenshotReferences = Object.freeze({ createCache });
})(globalThis);
