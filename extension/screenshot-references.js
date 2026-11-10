(function attachClassPilotScreenshotReferences(root) {
  'use strict';
  const MAX_CACHED_SOURCE_LENGTH = 2 * 1024 * 1024;
  const OPAQUE_IMAGE_ID = /^[A-Za-z0-9_-]{16,128}$/;

  // One acknowledged image and the current actual capture, in memory only.
  // The caller creates a ticket only AFTER fresh capture/encoding and supplies
  // the exact auth + screenshot authority scope. This never schedules captures
  // or manufactures freshness from a heartbeat/reference lookup.
  function createCache() {
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

    return Object.freeze({ prepare, accept, fullBody, clear });
  }

  root.ClassPilotScreenshotReferences = Object.freeze({ createCache });
})(globalThis);
