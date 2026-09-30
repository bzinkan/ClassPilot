(function attachClassPilotRuntimeCore(root) {
  'use strict';

  // Normative SchoolPilot matcher port; only its server-only PSL check is omitted.
  const PROVIDERS = new Set(['youtube', 'google_docs', 'google_slides', 'google_sheets', 'google_forms', 'google_drive']);
  const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
  const GOOGLE_FILE_ID = /^[A-Za-z0-9_-]{20,128}$/;
  const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'youtube-nocookie.com']);
  const YOUTUBE_PAGE_PATH = /^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})(\/.*)?$/;
  const YOUTUBE_PLAYER_PATH = /^\/(?:embed|v)\/([A-Za-z0-9_-]{11})\/?$/;
  const YOUTU_BE_PATH = /^\/([A-Za-z0-9_-]{11})\/?$/;
  // An embedded player link identifies one video only with these parameters;
  // list, playlist and listType (or anything else) let it play other videos.
  const YOUTUBE_PLAYER_PARAMETERS = new Set([
    'autoplay', 'cc_lang_pref', 'cc_load_policy', 'color', 'controls', 'disablekb', 'enablejsapi',
    'end', 'feature', 'fs', 'hl', 'iv_load_policy', 'loop', 'modestbranding', 'mute', 'origin',
    'playsinline', 'rel', 'si', 'start', 't', 'widget_referrer',
  ]);
  // The raw value of an allowlisted player parameter: no separators or escapes.
  const YOUTUBE_PLAYER_VALUE = /^[A-Za-z0-9._:/-]*$/;
  const YOUTUBE_RESERVED_IDS = new Set(['videoseries', 'live_stream']);
  // A path tail below a section prefix or after a provider id (the server's
  // RESTRICTION_PATH_TAIL_PATTERN): no ';', encoded separator or dot, overlong
  // UTF-8, fullwidth dot or slash, or malformed escape.
  const RESTRICTION_PATH_TAIL = new RegExp('^(?:/(?:[^?#%;]|%(?:[013-46-9abdfABDF][0-9a-fA-F]|2[0-46-9a-dA-D]|5[0-9abd-fABD-F]|[Cc][2-9a-fA-F]'
    + '|[Ee][1-9a-eA-E]|[Ee]0%[AaBb][0-9a-fA-F]|[Ee][Ff]%(?:[0-9ac-fAC-F][0-9a-fA-F]|[Bb][0-9abd-fABD-F]'
    + '|[Bb][Cc]%(?:[0-79ac-fAC-F][0-9a-fA-F]|8[0-9a-dA-D]|[Bb][0-9abd-fABD-F]))))*)?$');
  const DOCS_PATH = /^\/(?:u\/[0-9]{1,2}\/)?(document|presentation|spreadsheets|forms)\/(?:u\/[0-9]{1,2}\/)?d\/(e\/)?([A-Za-z0-9_-]{20,128})(\/.*)?$/;
  const DRIVE_FILE_PATH = /^\/(?:u\/[0-9]{1,2}\/)?file\/(?:u\/[0-9]{1,2}\/)?d\/([A-Za-z0-9_-]{20,128})(\/.*)?$/;
  const DRIVE_ID_PATH = /^\/(?:u\/[0-9]{1,2}\/)?(?:open|uc)$/;
  const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const DOCS_KIND_PROVIDER = { document: 'google_docs', presentation: 'google_slides', spreadsheets: 'google_sheets', forms: 'google_forms' };
  const PROVIDER_DOCS_KIND = { google_docs: 'document', google_slides: 'presentation', google_sheets: 'spreadsheets', google_forms: 'forms' };

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function hasExactKeys(value, keys) {
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  }

  function restrictionMatchHostname(hostname) {
    let host = String(hostname || '').toLowerCase();
    if (host.endsWith('.')) host = host.slice(0, -1);
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  }

  function syntacticallyCanonicalHostname(value) {
    if (typeof value !== 'string' || !value || value.length > 253) return false;
    if (restrictionMatchHostname(value) !== value) return false;
    const labels = value.split('.');
    if (labels.length < 2 || labels.some((label) => !HOSTNAME_LABEL.test(label))) return false;
    return !/^[0-9]+$/.test(labels[labels.length - 1]);
  }

  function providerHostname(provider) {
    if (provider === 'youtube') return 'youtube.com';
    if (provider === 'google_drive') return 'drive.google.com';
    return 'docs.google.com';
  }

  function youtubeVideoId(value) {
    return typeof value === 'string' && YOUTUBE_ID.test(value) && !YOUTUBE_RESERVED_IDS.has(value) ? value : null;
  }

  function validResourceId(provider, resourceId) {
    if (typeof resourceId !== 'string') return false;
    if (provider === 'youtube') return youtubeVideoId(resourceId) !== null;
    if (provider === 'google_drive') return GOOGLE_FILE_ID.test(resourceId);
    return GOOGLE_FILE_ID.test(resourceId.startsWith('e/') ? resourceId.slice(2) : resourceId);
  }

  function canonicalRestrictionResourceUrl(provider, resourceId) {
    if (provider === 'youtube') return `https://www.youtube.com/watch?v=${resourceId}`;
    if (provider === 'google_drive') return `https://drive.google.com/file/d/${resourceId}/view`;
    const kind = PROVIDER_DOCS_KIND[provider];
    if (provider === 'google_forms') return `https://docs.google.com/forms/d/${resourceId}/viewform`;
    if (resourceId.startsWith('e/')) {
      return `https://docs.google.com/${kind}/d/${resourceId}/${provider === 'google_sheets' ? 'pubhtml' : 'pub'}`;
    }
    return `https://docs.google.com/${kind}/d/${resourceId}/edit`;
  }

  function safePathTail(tail) {
    return RESTRICTION_PATH_TAIL.test(tail ?? '');
  }

  function validSectionPathPrefix(value) {
    if (typeof value !== 'string' || value.length < 2 || value.length > 512) return false;
    if (!value.startsWith('/') || value.endsWith('/') || value.includes('//') || /[?#\\\s]/.test(value)) return false;
    if (!RESTRICTION_PATH_TAIL.test(value)) return false;
    try {
      return new URL(`https://example.com${value}`).pathname === value;
    } catch {
      return false;
    }
  }

  /** Structural validation of a delivered entry (the server also applies the public-suffix list). */
  function isValidRestrictionResource(value) {
    if (!isPlainObject(value) || !syntacticallyCanonicalHostname(value.hostname)) return false;
    if (value.type === 'website') {
      return hasExactKeys(value, ['type', 'hostname', 'includeSubdomains']) && value.includeSubdomains === true;
    }
    if (value.type === 'section') {
      return hasExactKeys(value, ['type', 'hostname', 'includeSubdomains', 'pathPrefix'])
        && value.includeSubdomains === false
        && validSectionPathPrefix(value.pathPrefix);
    }
    if (value.type === 'resource') {
      return hasExactKeys(value, ['type', 'hostname', 'includeSubdomains', 'provider', 'resourceId', 'canonicalUrl'])
        && value.includeSubdomains === false
        && PROVIDERS.has(value.provider)
        && validResourceId(value.provider, value.resourceId)
        && value.hostname === providerHostname(value.provider)
        && value.canonicalUrl === canonicalRestrictionResourceUrl(value.provider, value.resourceId);
    }
    return false;
  }

  function youtubeHostVideoId(parsed) {
    if (parsed.pathname === '/watch') {
      const ids = parsed.searchParams.getAll('v');
      return ids.length === 1 ? youtubeVideoId(ids[0]) : null;
    }
    const player = YOUTUBE_PLAYER_PATH.exec(parsed.pathname);
    if (player) return youtubePlayerQueryHarmless(parsed.search) ? youtubeVideoId(player[1]) : null;
    const page = YOUTUBE_PAGE_PATH.exec(parsed.pathname);
    return page && safePathTail(page[2]) ? youtubeVideoId(page[1]) : null;
  }

  // Every raw name[=value] segment of a player link's query is allowlisted.
  function youtubePlayerQueryHarmless(search) {
    if (search === '') return true;
    return search.slice(1).split('&').every((segment) => {
      if (segment === '') return true;
      const separator = segment.indexOf('=');
      const name = separator === -1 ? segment : segment.slice(0, separator);
      const value = separator === -1 ? '' : segment.slice(separator + 1);
      return YOUTUBE_PLAYER_PARAMETERS.has(name) && YOUTUBE_PLAYER_VALUE.test(value);
    });
  }

  function identityFromParsedUrl(parsed) {
    const host = restrictionMatchHostname(parsed.hostname);
    if (YOUTUBE_HOSTS.has(host)) {
      const id = youtubeHostVideoId(parsed);
      return id ? { provider: 'youtube', resourceId: id } : null;
    }
    if (host === 'youtu.be') {
      const id = youtubeVideoId(YOUTU_BE_PATH.exec(parsed.pathname)?.[1]);
      return id ? { provider: 'youtube', resourceId: id } : null;
    }
    if (host === 'docs.google.com') {
      const match = DOCS_PATH.exec(parsed.pathname);
      return match && safePathTail(match[4])
        ? { provider: DOCS_KIND_PROVIDER[match[1]], resourceId: `${match[2] || ''}${match[3]}` }
        : null;
    }
    if (host === 'drive.google.com') {
      const file = DRIVE_FILE_PATH.exec(parsed.pathname);
      if (file) return safePathTail(file[2]) ? { provider: 'google_drive', resourceId: file[1] } : null;
      if (DRIVE_ID_PATH.test(parsed.pathname)) {
        const ids = parsed.searchParams.getAll('id');
        return ids.length === 1 && GOOGLE_FILE_ID.test(ids[0]) ? { provider: 'google_drive', resourceId: ids[0] } : null;
      }
    }
    return null;
  }

  function extractRestrictionResourceIdentity(url) {
    if (typeof url !== 'string' || url.length > 8192) return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
    return identityFromParsedUrl(parsed);
  }

  function isUrlAllowedByRestrictionResource(url, resource) {
    if (!isValidRestrictionResource(resource) || typeof url !== 'string') return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.username || parsed.password) return false;
    const host = restrictionMatchHostname(parsed.hostname);
    if (resource.type === 'website') {
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
      return host === resource.hostname || host.endsWith(`.${resource.hostname}`);
    }
    if (parsed.protocol !== 'https:' || parsed.port) return false;
    if (resource.type === 'section') {
      return host === resource.hostname
        && (parsed.pathname === resource.pathPrefix || parsed.pathname.startsWith(`${resource.pathPrefix}/`))
        && safePathTail(parsed.pathname.slice(resource.pathPrefix.length));
    }
    const identity = identityFromParsedUrl(parsed);
    return !!identity && identity.provider === resource.provider && identity.resourceId === resource.resourceId;
  }

  function preciseRestrictionError(message, code = 'PRECISE_RESTRICTION_INVALID') {
    return Object.assign(new Error(message), { code });
  }

  function restrictionResourceIdentityKey(resource) {
    if (resource.type === 'website') return `website:${resource.hostname}`;
    if (resource.type === 'section') return `section:${resource.hostname}${resource.pathPrefix}`;
    return `resource:${resource.provider}:${resource.resourceId}`;
  }

  function restrictionResourceRuleCount(resource) {
    return resource.type === 'website' ? 0 : resource.type === 'resource' && resource.provider === 'youtube' ? 2 : 1;
  }

  function validateAllowedResourceList(value) {
    if (!Array.isArray(value) || value.length > 200) return null;
    const result = [], seen = new Set();
    for (const entry of value) {
      if (!isValidRestrictionResource(entry)) return null;
      const key = restrictionResourceIdentityKey(entry);
      if (seen.has(key)) return null;
      seen.add(key);
      result.push({ ...entry });
    }
    if (result.reduce((sum, entry) => sum + restrictionResourceRuleCount(entry), 0) > 997
      || new TextEncoder().encode(JSON.stringify(result)).length > 49152) return null;
    return result;
  }

  function canonicalUrlForResource(resource) {
    return resource.type === 'resource' ? resource.canonicalUrl
      : `https://${resource.hostname}${resource.type === 'section' ? resource.pathPrefix : ''}`;
  }

  function hasPreciseRestrictions(state) {
    return Boolean(state?.restrictions?.screenLock?.resource
      || state?.restrictions?.flightPath?.resources?.length);
  }

  function restrictionLandingUrl(state) {
    const restrictions = state?.restrictions ?? emptyRestrictions();
    if (restrictions.screenLock?.active) return restrictions.screenLock.url;
    if (!restrictions.flightPath?.active) return null;
    const domain = restrictions.flightPath.allowedDomains?.[0];
    return domain ? `https://${domain}` : restrictions.flightPath.resources?.[0]
      ? canonicalUrlForResource(restrictions.flightPath.resources[0]) : null;
  }

  function decideNavigation(url, policy, nowValue = Date.now()) {
    const state = policy?.classroomState;
    const restrictions = state?.restrictions ?? emptyRestrictions();
    const host = normalizeDomain(url);
    if (!isHttpTab({ url }) || !host) return { allowed: true, source: null };
    if (restrictions.attentionMode?.active) return { allowed: false, source: 'attention_mode' };
    const matches = domains => (domains || []).some(domain => isHostWithinDomain(host, normalizeDomain(domain)));
    if (matches(policy?.globalBlockedDomains)) return { allowed: false, source: 'school' };
    const restricted = restrictions.screenLock?.active || restrictions.flightPath?.active;
    const temporary = normalizeTemporaryAllows(restrictions.temporaryAllows, timestampMs(nowValue) ?? Date.now());
    const temporarilyAllowed = temporary.some(item => isHostWithinDomain(host, item.domain));
    if (!restricted && temporarilyAllowed) return { allowed: true, source: 'temporary' };
    if (restrictions.blockList?.active && matches(restrictions.blockList.blockedDomains))
      return { allowed: false, source: 'teacher' };
    if (restricted && ((policy?.restrictionAuthPassThrough === true && state?.authPassThrough
      && authPassThroughProfileForUrl(state.authPassThrough, url))
      || (policy?.restrictionSsoPassThrough === true && state?.deliveryContext?.lateSignInRestrictionSso === true
        && isRestrictionSsoTab({ url })))) return { allowed: true, source: 'authentication' };
    if (restrictions.screenLock?.active) return {
      allowed: isRestrictionDestinationUrl(state, url),
      source: restrictions.screenLock.resource ? 'resource' : 'screen_lock',
    };
    if (temporarilyAllowed) return { allowed: true, source: 'temporary' };
    if (restrictions.flightPath?.active) return {
      allowed: isRestrictionDestinationUrl(state, url),
      source: restrictions.flightPath.resources?.length ? 'resource' : 'flight_path',
    };
    return { allowed: true, source: null };
  }

  function restrictionResourceRegexes(resource, narrow = false) {
    if (!isValidRestrictionResource(resource)) throw preciseRestrictionError('Invalid DNR resource');
    if (resource.type === 'website') return [];
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tail = narrow ? '(?:/[^?#%;]*)?' : RESTRICTION_PATH_TAIL.source.slice(1, -1);
    const suffix = '(?:[?#].*)?$';
    if (resource.type === 'section')
      return [`^https://(?:www\\.)?${escape(resource.hostname)}${escape(resource.pathPrefix)}${tail}${suffix}`];
    const id = escape(resource.resourceId);
    if (resource.provider === 'youtube') {
      const host = '(?:(?:www\\.)?(?:m\\.)?youtube\\.com|(?:www\\.)?youtube-nocookie\\.com)';
      // P excludes raw and percent-encoded v keys; the allowed id occurs once.
      const other = '(?:[^v%&#=][^&#]*|v[^=&#][^&#]*|%(?:[^7&#][^&#]*|7(?:[^6&#][^&#]*)?)?|=[^&#]*)?';
      const parameter = `(?:(?:${[...YOUTUBE_PLAYER_PARAMETERS].join('|')})(?:=[A-Za-z0-9._:/-]*)?)?`;
      const page = `^https://${host}/(?:(?:shorts|live)/${id}${tail}(?:[?#].*)?$|watch\\?(?:${other}&)*v=${id}(?:&${other})*(?:#.*)?$)`;
      const narrowPage = `^https://(?:www\\.)?youtube\\.com/watch\\?v=${id}(?:&(?:t|start|list|feature|si)=[A-Za-z0-9._~-]*)*(?:#.*)?$`;
      const short = `(?:www\\.)?youtu\\.be/${id}/?(?:[?#].*)?`;
      const player = `${host}/(?:embed|v)/${id}/?(?:\\?${parameter}(?:&${parameter})*)?(?:#.*)?`;
      return [narrow ? narrowPage : page, `^https://(?:${short}${narrow ? '' : `|${player}`})$`];
    }
    // Long opaque IDs and account/host alternatives can exceed Chrome's
    // compiled RE2 memory limit. The canonical landing with an optional query
    // is a narrower fallback; it never admits a different document or file.
    if (narrow)
      return [`^${escape(canonicalUrlForResource(resource))}(?:[?#].*)?$`];
    const account = '(?:u/[0-9]{1,2}/)?';
    if (resource.provider === 'google_drive')
      return [`^https://(?:www\\.)?drive\\.google\\.com/${account}file/${account}d/${id}${tail}${suffix}`];
    return [`^https://(?:www\\.)?docs\\.google\\.com/${account}${PROVIDER_DOCS_KIND[resource.provider]}/${account}d/${id}${tail}${suffix}`];
  }

  function preciseDnrRules(resources, priority) {
    const parsed = validateAllowedResourceList(resources);
    if (!parsed) throw preciseRestrictionError('Invalid precise DNR resource list');
    return parsed.flatMap(resource => restrictionResourceRegexes(resource)).map((regexFilter, index) => ({
      id: DNR_RANGES.classroom[0] + 2 + index, priority, action: { type: 'allow' },
      condition: { resourceTypes: ['main_frame'], regexFilter, isUrlFilterCaseSensitive: true },
    }));
  }

  const CLASSROOM_STATE_SCHEMA_VERSION = 1;
  const CLASSROOM_STATE_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;
  const MAX_RULE_ENTRIES = 1000;
  const MAX_EVENT_OUTBOX_ENTRIES = 500;
  const MAX_EVENT_OUTBOX_BYTES = 2 * 1024 * 1024;
  const MAX_EVENT_TITLE_LENGTH = 256;
  const MAX_EVENT_PATH_LENGTH = 512;
  const CONNECTIVITY_HEALTH_SCHEMA_VERSION = 1;
  const CONNECTIVITY_UNREACHABLE_AFTER_MS = 60 * 1000;
  const SCREENSHOT_HEALTH_SCHEMA_VERSION = 1;
  const MESSAGE_INBOX_SCHEMA_VERSION = 1;
  const MAX_MESSAGE_INBOX_ENTRIES = 50;
  const MAX_MESSAGE_DEDUP_IDS = 500;
  const MAX_MESSAGE_ID_LENGTH = 256;
  const MAX_MESSAGE_BODY_LENGTH = 2000;
  const WEEKDAYS = Object.freeze([
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
  ]);

  const DNR_RANGES = Object.freeze({
    classroom: Object.freeze([1, 1000]),
    school: Object.freeze([1000, 2000]),
    teacher: Object.freeze([2000, 3000]),
    temporary: Object.freeze([3000, 4000]),
    // Two allow rules plus up to 1,000 exact teacher-block overrides. Keep
    // enough room for every normalized teacher-domain entry without allowing
    // the override IDs to escape the range cleared atomically by the worker.
    restrictionSso: Object.freeze([4000, 6000]),
  });
  const RESTRICTION_SSO_DOMAINS = Object.freeze([
    'clever.com',
    'accounts.google.com',
  ]);
  const RESTRICTION_SSO_COLD_START_URL = 'https://clever.com/';
  const AUTH_PASS_THROUGH_SCHEMA_VERSION = 1;
  const AUTH_PASS_THROUGH_ATTEMPT_TTL_SECONDS = 300;
  const AUTH_PASS_THROUGH_MAX_PROFILES = 12;
  const AUTH_PASS_THROUGH_MAX_HOST_RULES_PER_PROFILE = 12;
  const AUTH_PASS_THROUGH_MAX_HOST_RULES = 144;
  // Defense in depth only: SchoolPilot performs authoritative full-PSL
  // validation (tldts) before an exact-bound envelope can reach the extension.
  // This compact list catches common malformed-wire suffixes without shipping
  // another dependency or managed-policy surface in the MV3 package.
  const AUTH_PASS_THROUGH_PUBLIC_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
    'com.au', 'net.au', 'org.au', 'edu.au',
    'co.nz', 'com.br', 'com.mx', 'co.jp', 'co.kr', 'co.in',
  ]);

  const MONITORING_EVENT_TYPES = new Set([
    'tab_changed',
    'navigation_changed',
    'navigation_blocked',
    'monitoring_state_changed',
    'restriction_state_applied',
    'restriction_state_failed',
    'restriction_state_cleared',
  ]);

  const POLICY_SOURCES = new Set([
    'resource',
    'school',
    'teacher',
    'flight_path',
    'screen_lock',
    'attention_mode',
    'tab_limit',
  ]);

  const CONNECTIVITY_ERROR_CATEGORIES = new Set([
    'network_error',
    'server_unavailable',
  ]);

  const SCREENSHOT_ERROR_CODES = new Set([
    'rate_limited_backoff',
    'tracking_off',
    'auth_stale',
    'no_config',
    'no_active_tab',
    'non_http_page',
    'capture_empty',
    'capture_failed',
    'upload_failed',
    'upload_client_error',
    'upload_server_error',
  ]);

  const DELIVERY_POLICIES = new Set([
    'persistent_control',
    'transient_action',
    'durable_message',
    'server_authoritative',
  ]);

  const TRANSIENT_COMMAND_TYPES = new Set([
    'open-tab',
    'close-tab',
    'close-tabs',
    'timer',
    'poll',
  ]);

  const PERSISTENT_COMMAND_TYPES = new Set([
    'lock-screen',
    'unlock-screen',
    'apply-flight-path',
    'remove-flight-path',
    'temp-unblock',
    'apply-block-list',
    'remove-block-list',
    'limit-tabs',
    'attention-mode',
  ]);

  function finiteInteger(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function timestampMs(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function boundedString(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
  }

  function positiveTimestamp(value) {
    const parsed = timestampMs(value);
    return parsed !== null && parsed > 0 ? parsed : null;
  }

  function emptyConnectivityHealth() {
    return {
      schemaVersion: CONNECTIVITY_HEALTH_SCHEMA_VERSION,
      lastSuccessAt: null,
      lastFailureAt: null,
      failureStartedAt: null,
      consecutiveFailures: 0,
      errorCategory: null,
    };
  }

  function normalizeConnectivityHealth(rawHealth) {
    if (!rawHealth || Number(rawHealth.schemaVersion) !== CONNECTIVITY_HEALTH_SCHEMA_VERSION) {
      return emptyConnectivityHealth();
    }
    const consecutiveFailures = finiteInteger(rawHealth.consecutiveFailures, 0);
    return {
      schemaVersion: CONNECTIVITY_HEALTH_SCHEMA_VERSION,
      lastSuccessAt: positiveTimestamp(rawHealth.lastSuccessAt),
      lastFailureAt: consecutiveFailures > 0 ? positiveTimestamp(rawHealth.lastFailureAt) : null,
      failureStartedAt: consecutiveFailures > 0
        ? positiveTimestamp(rawHealth.failureStartedAt ?? rawHealth.lastFailureAt)
        : null,
      consecutiveFailures,
      errorCategory: consecutiveFailures > 0 && CONNECTIVITY_ERROR_CATEGORIES.has(rawHealth.errorCategory)
        ? rawHealth.errorCategory
        : null,
    };
  }

  function connectivityHealthAfterSuccess(rawHealth, nowValue = Date.now()) {
    const nowMs = positiveTimestamp(nowValue) ?? Date.now();
    return {
      ...emptyConnectivityHealth(),
      lastSuccessAt: nowMs,
    };
  }

  function connectivityHealthAfterFailure(rawHealth, errorCategory, nowValue = Date.now()) {
    const current = normalizeConnectivityHealth(rawHealth);
    const nowMs = positiveTimestamp(nowValue) ?? Date.now();
    return {
      schemaVersion: CONNECTIVITY_HEALTH_SCHEMA_VERSION,
      lastSuccessAt: current.lastSuccessAt,
      lastFailureAt: nowMs,
      failureStartedAt: current.failureStartedAt ?? nowMs,
      consecutiveFailures: current.consecutiveFailures + 1,
      errorCategory: CONNECTIVITY_ERROR_CATEGORIES.has(errorCategory)
        ? errorCategory
        : 'network_error',
    };
  }

  function connectivityHealthState(rawHealth, nowValue = Date.now()) {
    const health = normalizeConnectivityHealth(rawHealth);
    const nowMs = positiveTimestamp(nowValue) ?? Date.now();
    const referenceAt = health.lastSuccessAt ?? health.failureStartedAt;
    if (!referenceAt) {
      return { state: 'checking', boundaryAt: null, health };
    }
    const boundaryAt = referenceAt + CONNECTIVITY_UNREACHABLE_AFTER_MS;
    if (nowMs >= boundaryAt) {
      return { state: 'unreachable', boundaryAt, health };
    }
    if (health.consecutiveFailures > 0) {
      return { state: 'reconnecting', boundaryAt, health };
    }
    return { state: 'connected', boundaryAt, health };
  }

  function emptyScreenshotHealth() {
    return {
      schemaVersion: SCREENSHOT_HEALTH_SCHEMA_VERSION,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
    };
  }

  function normalizeScreenshotHealth(rawHealth) {
    if (!rawHealth || Number(rawHealth.schemaVersion) !== SCREENSHOT_HEALTH_SCHEMA_VERSION) {
      return emptyScreenshotHealth();
    }
    return {
      schemaVersion: SCREENSHOT_HEALTH_SCHEMA_VERSION,
      lastAttemptAt: positiveTimestamp(rawHealth.lastAttemptAt),
      lastSuccessAt: positiveTimestamp(rawHealth.lastSuccessAt),
      lastErrorAt: positiveTimestamp(rawHealth.lastErrorAt),
      lastErrorCode: SCREENSHOT_ERROR_CODES.has(rawHealth.lastErrorCode)
        ? rawHealth.lastErrorCode
        : null,
    };
  }

  function commandDeliveryPolicy(commandType, explicitPolicy) {
    if (DELIVERY_POLICIES.has(explicitPolicy)) return explicitPolicy;
    if (TRANSIENT_COMMAND_TYPES.has(commandType)) return 'transient_action';
    if (PERSISTENT_COMMAND_TYPES.has(commandType)) return 'persistent_control';
    if (commandType === 'teacher-message') return 'durable_message';
    if (commandType === 'student-sign-out') return 'server_authoritative';
    return null;
  }

  function commandDeliveryState(command, envelope = {}, nowValue = Date.now()) {
    const commandType = boundedString(command?.type, 80) || 'unknown';
    const explicitPolicy = envelope?.deliveryPolicy
      ?? envelope?.data?.deliveryPolicy
      ?? command?.deliveryPolicy
      ?? command?.data?.deliveryPolicy;
    const deliveryPolicy = commandDeliveryPolicy(commandType, explicitPolicy);
    const expiresAt = positiveTimestamp(
      envelope?.expiresAt
      ?? envelope?.data?.expiresAt
      ?? command?.expiresAt
      ?? command?.data?.commandExpiresAt
    );
    const nowMs = positiveTimestamp(nowValue) ?? Date.now();
    return {
      commandType,
      deliveryPolicy,
      expiresAt,
      expired: deliveryPolicy === 'transient_action' && expiresAt !== null && nowMs >= expiresAt,
    };
  }

  function timeOfDayMinutes(value, fallback) {
    const match = /^(\d{2}):(\d{2})$/.exec(typeof value === 'string' ? value.trim() : '');
    if (!match) return fallback;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
      ? hour * 60 + minute
      : fallback;
  }

  function isWithinTrackingWindow(input = {}) {
    if (!input.enabled) return true;
    const start = timeOfDayMinutes(input.startTime, 0);
    const end = timeOfDayMinutes(input.endTime, 23 * 60 + 59);
    const activeDays = new Set(Array.isArray(input.activeDays) ? input.activeDays : WEEKDAYS.slice(1, 6));
    const instant = new Date(timestampMs(input.now) ?? Date.now());
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: input.timezone || 'America/New_York',
        weekday: 'long',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(instant);
      const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      const weekdayIndex = WEEKDAYS.indexOf(value.weekday);
      if (weekdayIndex < 0) return true;
      const current = (Number(value.hour) % 24) * 60 + Number(value.minute);
      if (!Number.isFinite(current)) return true;

      let date = `${value.year}-${value.month}-${value.day}`;
      const afterMidnight = end < start && current <= end;
      if (afterMidnight) date = new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
      const calendarWeekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      const override = input.schedulingDateOverrides?.[date];
      const instructional = override?.instructional ?? (![0, 6].includes(calendarWeekday)
        && !(input.instructionalCalendar?.[date.slice(0, 7)]?.nonInstructionalDates || []).includes(date));
      if (!instructional) return false;
      const meetingWeekday = override?.instructional === true ? override.meetingWeekday ?? calendarWeekday : calendarWeekday;
      const enabledDay = activeDays.has(WEEKDAYS[meetingWeekday]);

      if (end > start) {
        return enabledDay && current >= start && current <= end;
      }

      // An end at or before the start is an overnight window. The segment
      // after midnight belongs to the prior configured school day.
      return enabledDay && (current >= start || current <= end);
    } catch (_) {
      // Preserve the existing fail-open behavior if a managed timezone is
      // malformed; the server will continue reporting the settings error.
      return true;
    }
  }

  function normalizeDomain(value) {
    if (typeof value !== 'string') return null;
    let candidate = value.trim().toLowerCase();
    if (!candidate) return null;
    try {
      if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) {
        candidate = `https://${candidate}`;
      }
      const parsed = new URL(candidate);
      const hostname = parsed.hostname.replace(/^www\./, '').replace(/\.$/, '');
      if (!hostname || hostname.length > 253 || /\s/.test(hostname)) return null;
      return hostname;
    } catch (_) {
      return null;
    }
  }

  function isHostWithinDomain(hostValue, domainValue) {
    if (typeof hostValue !== 'string' || typeof domainValue !== 'string') return false;
    const host = hostValue.trim().toLowerCase().replace(/\.$/, '');
    const domain = domainValue.trim().toLowerCase().replace(/\.$/, '');
    if (!host || !domain) return false;
    return host === domain || host.endsWith(`.${domain}`);
  }

  function normalizeDomainList(values, label = 'domain list') {
    if (values === null || values === undefined) return [];
    if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
    if (values.length > MAX_RULE_ENTRIES) {
      throw new Error(`${label} exceeds the 1,000 entry limit`);
    }
    const normalized = [];
    const seen = new Set();
    for (const value of values) {
      const domain = normalizeDomain(value);
      if (!domain) throw new Error(`${label} contains an invalid domain`);
      if (seen.has(domain)) continue;
      seen.add(domain);
      normalized.push(domain);
    }
    return normalized;
  }

  function normalizeAuthHostname(value) {
    if (typeof value !== 'string') return null;
    const candidate = value.trim().toLowerCase();
    if (!candidate
      || candidate.length > 253
      || candidate.endsWith('.')
      || candidate === 'localhost'
      || AUTH_PASS_THROUGH_PUBLIC_SUFFIXES.has(candidate)) return null;
    if (candidate.includes('://') || /[/?#@\\*]/.test(candidate)) return null;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate) || candidate.includes(':')) return null;
    const labels = candidate.split('.');
    if (labels.length < 2 || labels.some((label) => (
      !label
      || label.length > 63
      || label.startsWith('xn--')
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ))) return null;
    const resemblesClever = labels.some((label) => label.includes('clever'));
    const resemblesGoogle = labels.some((label) => label.includes('google'));
    if (resemblesClever
      && candidate !== 'clever.com'
      && !candidate.endsWith('.clever.com')) return null;
    if (resemblesGoogle && candidate !== 'accounts.google.com') return null;
    try {
      const parsed = new URL(`https://${candidate}/`);
      return parsed.hostname.toLowerCase().replace(/\.$/, '') === candidate
        ? candidate
        : null;
    } catch (_) {
      return null;
    }
  }

  function authHostRuleMatchesHost(rule, hostValue) {
    const host = normalizeAuthHostname(hostValue);
    if (!host || !rule?.hostname) return false;
    return rule.includeSubdomains === true
      ? isHostWithinDomain(host, rule.hostname)
      : host === rule.hostname;
  }

  function normalizeAuthPassThrough(rawPolicy) {
    if (rawPolicy === undefined) return null;
    if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
      throw new Error('authPassThrough must be an object');
    }
    if (Number(rawPolicy.schemaVersion) !== AUTH_PASS_THROUGH_SCHEMA_VERSION) {
      throw new Error('unsupported authPassThrough schema version');
    }
    const policyRevision = Number(rawPolicy.policyRevision);
    if (!Number.isSafeInteger(policyRevision) || policyRevision < 0) {
      throw new Error('authPassThrough policyRevision must be a non-negative safe integer');
    }
    if (Number(rawPolicy.attemptTtlSeconds) !== AUTH_PASS_THROUGH_ATTEMPT_TTL_SECONDS) {
      throw new Error('authPassThrough attempt TTL must be 300 seconds');
    }
    if (!Array.isArray(rawPolicy.profiles)
      || rawPolicy.profiles.length < 1
      || rawPolicy.profiles.length > AUTH_PASS_THROUGH_MAX_PROFILES) {
      throw new Error('authPassThrough profiles must contain 1 to 12 entries');
    }
    let hostRuleCount = 0;
    const profileIds = new Set();
    const profiles = rawPolicy.profiles.map((rawProfile) => {
      const id = boundedString(rawProfile?.id, 64).toLowerCase();
      const name = boundedString(rawProfile?.name, 120);
      if (!/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(id) || profileIds.has(id)) {
        throw new Error('authPassThrough contains an invalid or duplicate profile id');
      }
      profileIds.add(id);
      if (!name) throw new Error('authPassThrough profile name is required');
      if (!Array.isArray(rawProfile?.hostRules)
        || rawProfile.hostRules.length < 1
        || rawProfile.hostRules.length > AUTH_PASS_THROUGH_MAX_HOST_RULES_PER_PROFILE) {
        throw new Error('authPassThrough profile hostRules must contain 1 to 12 entries');
      }
      const seenRules = new Set();
      const hostRules = rawProfile.hostRules.map((rawRule) => {
        const hostname = normalizeAuthHostname(rawRule?.hostname);
        if (!hostname || typeof rawRule?.includeSubdomains !== 'boolean') {
          throw new Error('authPassThrough contains an invalid host rule');
        }
        const includeSubdomains = rawRule.includeSubdomains === true;
        // Google Accounts is the narrowly-scoped authentication authority. A
        // custom profile must not broaden it to arbitrary google.com children.
        if (hostname === 'accounts.google.com' && includeSubdomains) {
          throw new Error('accounts.google.com authentication must use exact-host matching');
        }
        const key = `${hostname}:${includeSubdomains ? 'subdomains' : 'exact'}`;
        if (seenRules.has(key)) {
          throw new Error('authPassThrough contains a duplicate host rule');
        }
        seenRules.add(key);
        hostRuleCount += 1;
        if (hostRuleCount > AUTH_PASS_THROUGH_MAX_HOST_RULES) {
          throw new Error('authPassThrough exceeds the 144 host-rule limit');
        }
        return { hostname, includeSubdomains };
      });
      let parsedStartUrl;
      try {
        parsedStartUrl = new URL(String(rawProfile?.startUrl || ''));
      } catch (_) {
        throw new Error('authPassThrough contains an invalid start URL');
      }
      if (parsedStartUrl.protocol !== 'https:'
        || parsedStartUrl.username
        || parsedStartUrl.password
        || parsedStartUrl.hash
        || (parsedStartUrl.port && parsedStartUrl.port !== '443')
        || String(rawProfile.startUrl).length > 2048) {
        throw new Error('authPassThrough start URL is not safe');
      }
      const startHost = normalizeAuthHostname(parsedStartUrl.hostname);
      if (!startHost || !hostRules.some((rule) => authHostRuleMatchesHost(rule, startHost))) {
        throw new Error('authPassThrough start URL is outside its approved host rules');
      }
      return {
        id,
        name,
        startUrl: parsedStartUrl.toString(),
        hostRules,
      };
    });
    const defaultProfileId = boundedString(rawPolicy.defaultProfileId, 64).toLowerCase();
    if (!defaultProfileId || !profileIds.has(defaultProfileId)) {
      throw new Error('authPassThrough defaultProfileId must select a profile');
    }
    return {
      schemaVersion: AUTH_PASS_THROUGH_SCHEMA_VERSION,
      policyRevision,
      defaultProfileId,
      attemptTtlSeconds: AUTH_PASS_THROUGH_ATTEMPT_TTL_SECONDS,
      profiles,
    };
  }

  function authPassThroughProfileForUrl(policy, urlValue) {
    if (!policy || typeof urlValue !== 'string') return null;
    let parsed;
    try {
      parsed = new URL(urlValue);
    } catch (_) {
      return null;
    }
    if (parsed.protocol !== 'https:' || (parsed.port && parsed.port !== '443')) return null;
    const host = normalizeAuthHostname(parsed.hostname);
    if (!host) return null;
    const matches = policy.profiles.filter((profile) => (
      profile.hostRules.some((rule) => authHostRuleMatchesHost(rule, host))
    ));
    if (matches.length < 2) return matches[0] || null;
    // Clever intentionally includes exact accounts.google.com so its Google-
    // backed login can continue, while the Google built-in also owns that
    // exact start host. Prefer the profile whose launch URL begins on the
    // observed host so the privacy-minimal provider id can represent a real
    // Clever -> Google -> Clever round-trip without storing visited hosts.
    return matches.find((profile) => {
      try {
        return normalizeAuthHostname(new URL(profile.startUrl).hostname) === host;
      } catch (_) {
        return false;
      }
    }) || matches[0];
  }

  function isDefaultRestrictionPortalUrl(policy, urlValue) {
    if (!authPassThroughProfileForUrl(policy, urlValue)) return false;
    const profile = policy.profiles.find((candidate) => candidate.id === policy.defaultProfileId);
    if (!profile) return false;
    const startHost = new URL(profile.startUrl).hostname;
    const destinationHost = new URL(urlValue).hostname;
    // A Clever profile also includes Google as an IdP dependency. Only the
    // approved host family containing the configured launch URL proves portal
    // entry; a leftover Google tab must not consume a fresh Clever login.
    return profile.hostRules.some((rule) => (
      authHostRuleMatchesHost(rule, startHost) && authHostRuleMatchesHost(rule, destinationHost)
    ));
  }

  function isAuthPassThroughTab(tab, policy) {
    return Boolean(isHttpTab(tab) && authPassThroughProfileForUrl(policy, tabUrl(tab)));
  }

  function normalizeTemporaryAllows(values, nowMs) {
    if (values === null || values === undefined) return [];
    if (!Array.isArray(values)) throw new Error('temporary allows must be an array');
    if (values.length > MAX_RULE_ENTRIES) {
      throw new Error('temporary allows exceeds the 1,000 entry limit');
    }
    const byDomain = new Map();
    for (const raw of values) {
      const domain = normalizeDomain(raw?.domain ?? raw?.hostname ?? raw);
      const expiresAt = timestampMs(raw?.expiresAt ?? raw?.expires_at);
      if (!domain) throw new Error('temporary allows contains an invalid domain');
      if (!expiresAt) throw new Error('temporary allows contains an invalid expiry');
      if (expiresAt <= nowMs) continue;
      const prior = byDomain.get(domain);
      if (!prior || expiresAt > prior.expiresAt) byDomain.set(domain, { domain, expiresAt });
    }
    return [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
  }

  function emptyRestrictions() {
    return {
      screenLock: { active: false, url: null, domain: null },
      flightPath: { active: false, allowedDomains: [], name: null },
      blockList: { active: false, blockedDomains: [], name: null },
      attentionMode: { active: false, message: '' },
      tabLimit: null,
      temporaryAllows: [],
    };
  }

  function normalizeRestrictions(rawRestrictions, nowMs) {
    const raw = rawRestrictions && typeof rawRestrictions === 'object' ? rawRestrictions : {};
    const rawScreenLock = raw.screenLock ?? raw.screen_lock ?? {};
    const rawFlightPath = raw.flightPath ?? raw.flight_path ?? {};
    const rawBlockList = raw.blockList ?? raw.block_list ?? {};
    const rawAttention = raw.attentionMode ?? raw.attention_mode ?? {};

    const hasResources = Object.prototype.hasOwnProperty.call(rawFlightPath, 'resources');
    const hasResource = Object.prototype.hasOwnProperty.call(rawScreenLock, 'resource');
    const resources = hasResources ? validateAllowedResourceList(rawFlightPath.resources) : [];
    if (!resources || (hasResources && (rawFlightPath.active !== true || !resources.length)))
      throw preciseRestrictionError('Flight Path resources must be a nonempty, valid active list');
    const resource = hasResource ? rawScreenLock.resource : null;
    if (hasResource && (rawScreenLock.active !== true || !isValidRestrictionResource(resource)
      || resource.type === 'website')) throw preciseRestrictionError('Waypoint resource is invalid');

    const screenUrl = boundedString(rawScreenLock.url ?? rawScreenLock.lockedUrl ?? raw.lockedUrl, 2048) || null;
    const screenDomain = normalizeDomain(
      rawScreenLock.domain ?? rawScreenLock.lockedDomain ?? raw.lockedDomain ?? screenUrl
    );
    const flightDomains = normalizeDomainList(
      rawFlightPath.allowedDomains ?? rawFlightPath.domains ?? raw.allowedDomains,
      'Flight Path domains'
    );
    const blockedDomains = normalizeDomainList(
      rawBlockList.blockedDomains ?? rawBlockList.domains ?? raw.teacherBlockedDomains,
      'teacher block list'
    );
    const temporaryAllows = normalizeTemporaryAllows(
      raw.temporaryAllows ?? raw.temporaryAllowedDomains ?? raw.temporary_allows,
      nowMs
    );
    const rawTabLimit = raw.tabLimit ?? raw.maxTabs ?? raw.currentMaxTabs;
    const parsedTabLimit = Number(rawTabLimit);
    const tabLimit = Number.isSafeInteger(parsedTabLimit) && parsedTabLimit > 0
      ? Math.min(parsedTabLimit, 1000)
      : null;
    const flightActive = Boolean(rawFlightPath.active ?? raw.flightPathActive ?? (flightDomains.length + resources.length > 0));
    const screenActive = Boolean(rawScreenLock.active ?? raw.screenLocked ?? screenDomain);
    const blockActive = Boolean(rawBlockList.active ?? blockedDomains.length > 0);
    if (flightActive && flightDomains.length + resources.length === 0) {
      throw new Error('active Flight Path requires at least one valid domain or resource');
    }
    if (screenActive && !screenDomain) {
      throw new Error('active screen lock requires a valid domain');
    }
    const canonicalResourceUrl = resource ? canonicalUrlForResource(resource) : null;
    const alternateSectionUrl = resource?.type === 'section'
      ? `https://www.${resource.hostname}${resource.pathPrefix}` : null;
    if (resource && screenUrl !== canonicalResourceUrl && screenUrl !== alternateSectionUrl)
      throw preciseRestrictionError('Waypoint URL does not equal the reviewed resource target');
    const safeScreenUrl = screenActive
      ? resource ? screenUrl : safeRestrictionTarget(screenUrl || `https://${screenDomain}`, screenDomain)
      : screenUrl;
    if (screenActive && !safeScreenUrl) {
      throw new Error('active screen lock requires a safe HTTPS URL without query or fragment data');
    }
    if (blockActive && blockedDomains.length === 0) {
      throw new Error('active teacher block list requires at least one valid domain');
    }

    return {
      screenLock: {
        active: screenActive && Boolean(screenDomain),
        url: safeScreenUrl,
        domain: screenDomain,
        ...(resource ? { resource: { ...resource } } : {}),
      },
      flightPath: {
        active: flightActive && flightDomains.length + resources.length > 0,
        allowedDomains: flightDomains,
        ...(hasResources ? { resources } : {}),
        name: boundedString(rawFlightPath.name ?? rawFlightPath.flightPathName ?? raw.activeFlightPathName, 200) || null,
      },
      blockList: {
        active: blockActive && blockedDomains.length > 0,
        blockedDomains,
        name: boundedString(rawBlockList.name ?? rawBlockList.blockListName ?? raw.activeBlockListName, 200) || null,
      },
      attentionMode: {
        active: Boolean(rawAttention.active ?? raw.attentionModeActive),
        message: boundedString(rawAttention.message ?? raw.attentionMessage, 500),
      },
      tabLimit,
      temporaryAllows,
    };
  }

  function normalizeClassroomState(rawState, nowValue = Date.now()) {
    if (!rawState || typeof rawState !== 'object') throw new Error('classroomState must be an object');
    const nowMs = timestampMs(nowValue) ?? Date.now();
    const explicitSchemaVersion = rawState.schemaVersion ?? rawState.schema_version;
    const schemaVersion = explicitSchemaVersion === null || explicitSchemaVersion === undefined
      ? CLASSROOM_STATE_SCHEMA_VERSION
      : Number(explicitSchemaVersion);
    if (schemaVersion !== CLASSROOM_STATE_SCHEMA_VERSION) {
      const error = new Error(`unsupported classroomState schema version: ${explicitSchemaVersion}`);
      error.code = 'UNSUPPORTED_CLASSROOM_STATE_SCHEMA';
      throw error;
    }
    const rawRevision = rawState.revision ?? rawState.studentControlRevision ?? rawState.student_control_revision;
    const revision = rawRevision === null || rawRevision === undefined ? 0 : Number(rawRevision);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error('classroomState revision must be a non-negative safe integer');
    }
    const session = rawState.session && typeof rawState.session === 'object' ? rawState.session : {};
    const teachingSessionId = boundedString(
      rawState.teachingSessionId ?? rawState.sessionId ?? session.teachingSessionId ?? session.id,
      128
    ) || null;
    const supervisionContextId = boundedString(
      rawState.supervisionContextId ?? session.supervisionContextId,
      128
    ) || null;
    if (teachingSessionId && supervisionContextId) {
      throw new Error('classroomState cannot contain both teaching and supervision scopes');
    }

    const receivedAt = timestampMs(rawState.receivedAt ?? rawState.issuedAt ?? rawState.generatedAt) ?? nowMs;
    // The device's receipt time is the authoritative safety boundary. A bad
    // or future server timestamp must never extend teacher controls beyond
    // twelve hours on this browser.
    const absoluteBackstop = nowMs + CLASSROOM_STATE_MAX_LIFETIME_MS;
    const requestedHardExpiry = timestampMs(
      rawState.hardExpiresAt ?? rawState.hardExpiry ?? rawState.hard_expires_at
    );
    const suppliedHardExpiry = rawState.hardExpiresAt !== undefined
      || rawState.hardExpiry !== undefined
      || rawState.hard_expires_at !== undefined;
    if ((teachingSessionId || supervisionContextId) && (!suppliedHardExpiry || requestedHardExpiry === null)) {
      throw new Error('scoped classroomState requires a valid hard expiry');
    }
    const hardExpiresAt = Math.min(requestedHardExpiry ?? absoluteBackstop, absoluteBackstop);
    const rawScheduledEnd = rawState.scheduledEndAt ?? rawState.scheduledEnd ?? rawState.scheduled_end;
    const requestedScheduledEnd = timestampMs(rawScheduledEnd);
    if (rawScheduledEnd !== undefined && rawScheduledEnd !== null && rawScheduledEnd !== '' && requestedScheduledEnd === null) {
      throw new Error('classroomState scheduled end must be a valid timestamp');
    }
    const scheduledEndAt = requestedScheduledEnd === null
      ? null
      : Math.min(requestedScheduledEnd, hardExpiresAt);
    const restrictions = normalizeRestrictions(
      rawState.restrictions ?? rawState.desiredRestrictions ?? rawState.desiredState ?? rawState,
      nowMs
    );
    const rawDeliveryContext = rawState.deliveryContext && typeof rawState.deliveryContext === 'object'
      ? rawState.deliveryContext
      : {};

    const authPassThrough = rawState.authPassThrough !== undefined
      ? normalizeAuthPassThrough(rawState.authPassThrough)
      : null;
    const rawAuthPolicyRevision = rawState.authPassThroughPolicyRevision;
    const authPassThroughPolicyRevision = rawAuthPolicyRevision === undefined
      ? null
      : finiteInteger(rawAuthPolicyRevision, -1);
    if (rawAuthPolicyRevision !== undefined && authPassThroughPolicyRevision < 0) {
      throw new Error('authPassThroughPolicyRevision must be a non-negative safe integer');
    }
    if (authPassThrough
      && authPassThroughPolicyRevision !== authPassThrough.policyRevision) {
      throw new Error('authPassThrough policy revision does not match its ordering fence');
    }

    return {
      schemaVersion: CLASSROOM_STATE_SCHEMA_VERSION,
      revision,
      teachingSessionId,
      supervisionContextId,
      receivedAt,
      scheduledEndAt,
      hardExpiresAt,
      restrictions,
      ...(authPassThrough ? { authPassThrough } : {}),
      ...(authPassThroughPolicyRevision !== null ? { authPassThroughPolicyRevision } : {}),
      ...(rawDeliveryContext.lateSignInRestrictionSso === true || rawDeliveryContext.portalFirstOnLogin === true ? {
        deliveryContext: {
          ...(rawDeliveryContext.lateSignInRestrictionSso === true ? { lateSignInRestrictionSso: true } : {}),
          ...(rawDeliveryContext.portalFirstOnLogin === true ? { portalFirstOnLogin: true } : {}),
        },
      } : {}),
    };
  }

  function normalizePersistedClassroomState(rawState, nowValue = Date.now()) {
    let wireState = rawState;
    if (rawState?.schemaVersion === 2) {
      if (rawState.precisePersistenceVersion !== 1 || !hasPreciseRestrictions(rawState))
        throw preciseRestrictionError('Unsupported persisted precise restriction');
      wireState = { ...rawState, schemaVersion: 1 };
      delete wireState.precisePersistenceVersion;
    }
    const normalized = normalizeClassroomState(wireState, nowValue);
    // Delivery validation must see the persisted SSO digest before the normal
    // wire normalizer removes private provenance. This helper is storage-only;
    // applyClassroomState validates the digest and normalizes the wire again.
    return { ...normalized, ...(wireState.deliveryContext ? {
      deliveryContext: { ...wireState.deliveryContext },
    } : {}) };
  }

  function classroomContext(value) {
    if (!value || typeof value !== 'object') return null;
    const teachingSessionId = boundedString(value.teachingSessionId ?? value.sessionId, 256) || null;
    const supervisionContextId = boundedString(value.supervisionContextId, 256) || null;
    if (Boolean(teachingSessionId) === Boolean(supervisionContextId)) return null;
    return supervisionContextId ? { supervisionContextId } : { teachingSessionId };
  }

  function classroomContextKey(value) {
    const context = classroomContext(value);
    return context ? context.supervisionContextId ? `supervision:${context.supervisionContextId}` : `teaching:${context.teachingSessionId}` : null;
  }

  function classroomContexts(value = {}) {
    const values = Array.isArray(value.activeContexts) ? value.activeContexts
      : (value.activeSessionIds || []).map(teachingSessionId => ({ teachingSessionId }));
    return [...new Map(values.map(classroomContext).filter(Boolean).map(context => [classroomContextKey(context), context])).values()];
  }

  function classroomStateExpiry(state, nowValue = Date.now()) {
    if (!state) return { expired: false, reason: null, expiresAt: null };
    const nowMs = timestampMs(nowValue) ?? Date.now();
    const candidates = [state.scheduledEndAt, state.hardExpiresAt]
      .filter((value) => Number.isFinite(value));
    if (candidates.length === 0) return { expired: false, reason: null, expiresAt: null };
    const expiresAt = Math.min(...candidates);
    if (nowMs < expiresAt) return { expired: false, reason: null, expiresAt };
    return {
      expired: true,
      reason: state.scheduledEndAt && state.scheduledEndAt <= state.hardExpiresAt && nowMs >= state.scheduledEndAt
        ? 'scheduled_end'
        : 'hard_expiry',
      expiresAt,
    };
  }

  function shouldApplyClassroomState(currentState, incomingState) {
    if (!currentState) return true;
    const incomingRevision = finiteInteger(incomingState?.revision, 0);
    const currentRevision = finiteInteger(currentState?.revision, 0);
    if (incomingRevision !== currentRevision) return incomingRevision > currentRevision;
    const currentPolicy = currentState?.authPassThrough || null;
    const incomingPolicy = incomingState?.authPassThrough || null;
    const currentFence = Number.isSafeInteger(currentState?.authPassThroughPolicyRevision)
      ? currentState.authPassThroughPolicyRevision
      : currentPolicy?.policyRevision ?? null;
    const incomingFence = Number.isSafeInteger(incomingState?.authPassThroughPolicyRevision)
      ? incomingState.authPassThroughPolicyRevision
      : incomingPolicy?.policyRevision ?? null;
    if (currentFence !== null) {
      if (incomingFence === null || incomingFence < currentFence) return false;
      if (incomingFence > currentFence) return true;
    } else if (incomingFence !== null) {
      return true;
    }
    if (Boolean(currentPolicy) !== Boolean(incomingPolicy)) return true;
    if (!currentPolicy || !incomingPolicy) return false;
    const currentPolicyRevision = finiteInteger(currentPolicy.policyRevision, 0);
    const incomingPolicyRevision = finiteInteger(incomingPolicy.policyRevision, 0);
    if (incomingPolicyRevision !== currentPolicyRevision) {
      return incomingPolicyRevision > currentPolicyRevision;
    }
    // Equal policy revisions are immutable. Accepting different content or a
    // presence toggle at the same fence would let a delayed frame re-enable a
    // revoked IdP policy. The server must advance the independent fence for
    // every policy or operator-gate transition.
    return false;
  }

  function isRuleInRange(ruleId, rangeName) {
    const range = DNR_RANGES[rangeName];
    return Boolean(range && ruleId >= range[0] && ruleId < range[1]);
  }

  function buildDnrRules(input, rangeNames = Object.keys(DNR_RANGES), nowValue = Date.now()) {
    const nowMs = timestampMs(nowValue) ?? Date.now();
    const ranges = new Set(rangeNames);
    const rules = [];
    const classroomState = input?.classroomState;
    const classroom = classroomState?.restrictions ?? emptyRestrictions();
    const globalDomains = normalizeDomainList(input?.globalBlockedDomains, 'school block list');

    if (ranges.has('classroom')) {
      if (classroom.attentionMode?.active) {
        rules.push({
          id: DNR_RANGES.classroom[0],
          priority: 2000,
          action: { type: 'block' },
          condition: { resourceTypes: ['main_frame'] },
        });
      } else {
        // A screen lock is an overlay, not a destructive replacement for an
        // independently configured Flight Path. It wins enforcement while
        // active; removing only the screen lock reveals the retained path.
        const screenLockDomains = classroom.screenLock?.active
          ? normalizeDomainList([classroom.screenLock.domain], 'screen lock domains')
          : [];
        const preciseWaypoint = classroom.screenLock?.active && classroom.screenLock.resource;
        const preciseEntries = classroom.flightPath?.active ? classroom.flightPath.resources || [] : [];
        if (preciseEntries.length && !validateAllowedResourceList(preciseEntries))
          throw preciseRestrictionError('Invalid Flight Path DNR list');
        const allowed = screenLockDomains.length > 0
          ? screenLockDomains
          : classroom.flightPath?.active
            ? normalizeDomainList(classroom.flightPath.allowedDomains, 'Flight Path domains')
            : [];
        if (preciseWaypoint) {
          rules.push({ id: DNR_RANGES.classroom[0], priority: 500, action: { type: 'block' },
            condition: { resourceTypes: ['main_frame'] } });
          rules.push(...preciseDnrRules([preciseWaypoint], 500));
        } else if (preciseEntries.length && !classroom.screenLock?.active) {
          const hosts = [...new Set([...allowed, ...preciseEntries.filter(entry => entry.type === 'website').map(entry => entry.hostname)])];
          rules.push({ id: DNR_RANGES.classroom[0], priority: 1, action: { type: 'block' },
            condition: { resourceTypes: ['main_frame'], ...(hosts.length ? { excludedRequestDomains: hosts } : {}) } });
          rules.push(...preciseDnrRules(preciseEntries, 2));
        } else if (allowed.length > 0) {
          const screenLockPriority = screenLockDomains.length > 0 ? 500 : 1;
          rules.push({
            id: DNR_RANGES.classroom[0],
            priority: screenLockPriority,
            action: { type: 'block' },
            condition: { resourceTypes: ['main_frame'], excludedRequestDomains: allowed },
          });
          if (screenLockDomains.length > 0) {
            // Make the lock target authoritative over teacher block-list and
            // temporary-allow rules, while the school range remains higher.
            rules.push({
              id: DNR_RANGES.classroom[0] + 1,
              priority: screenLockPriority,
              action: { type: 'allow' },
              condition: { resourceTypes: ['main_frame'], requestDomains: screenLockDomains },
            });
          }
        }
      }
    }

    if (ranges.has('school')) {
      for (const [index, domain] of globalDomains.entries()) {
        rules.push({
          id: DNR_RANGES.school[0] + index,
          // School policy stays authoritative even if a teacher temporarily
          // allows the same domain.
          priority: 1000,
          action: { type: 'block' },
          condition: { resourceTypes: ['main_frame'], requestDomains: [domain] },
        });
      }
    }

    if (ranges.has('teacher')) {
      const teacherDomains = classroom.blockList?.active
        ? normalizeDomainList(classroom.blockList.blockedDomains, 'teacher block list')
        : [];
      for (const [index, domain] of teacherDomains.entries()) {
        rules.push({
          id: DNR_RANGES.teacher[0] + index,
          // Teacher policy is authoritative over authentication exceptions,
          // Waypoints, and Flight Paths. A time-bounded temporary allow below
          // remains the only teacher-scoped override.
          priority: 800,
          action: { type: 'block' },
          condition: { resourceTypes: ['main_frame'], requestDomains: [domain] },
        });
      }
    }

    if (ranges.has('temporary')) {
      const temporaryAllows = normalizeTemporaryAllows(classroom.temporaryAllows, nowMs);
      const destinationRestrictionActive = Boolean(
        classroom.screenLock?.active || classroom.flightPath?.active,
      );
      for (const [index, item] of temporaryAllows.entries()) {
        rules.push({
          id: DNR_RANGES.temporary[0] + index,
          // A teacher's temporary unblock can override their ordinary block
          // list, but never becomes a second restriction escape hatch while
          // a Waypoint or Flight Path is active.
          priority: destinationRestrictionActive ? 100 : 900,
          action: { type: 'allow' },
          condition: { resourceTypes: ['main_frame'], requestDomains: [item.domain] },
        });
      }
    }

    if (ranges.has('restrictionSso')) {
      const authPassThrough = classroomState?.authPassThrough || null;
      const restrictionAuthPassThroughActive = input?.restrictionAuthPassThrough === true
        && Boolean(authPassThrough)
        && !classroom.attentionMode?.active
        && (classroom.screenLock?.active || classroom.flightPath?.active);
      const legacyRestrictionSsoActive = input?.restrictionSsoPassThrough === true
        && classroomState?.deliveryContext?.lateSignInRestrictionSso === true
        && !classroom.attentionMode?.active
        && (classroom.screenLock?.active || classroom.flightPath?.active);
      if (restrictionAuthPassThroughActive || legacyRestrictionSsoActive) {
        const candidateAuthRules = restrictionAuthPassThroughActive
          ? authPassThrough.profiles.flatMap((profile) => profile.hostRules)
          : RESTRICTION_SSO_DOMAINS.map((hostname) => ({ hostname, includeSubdomains: true }));
        const seenAuthRules = new Set();
        const authRules = candidateAuthRules.filter((rule) => {
          const key = `${rule.hostname}:${rule.includeSubdomains === true ? 'subdomains' : 'exact'}`;
          if (seenAuthRules.has(key)) return false;
          seenAuthRules.add(key);
          return true;
        });
        for (const [index, rule] of authRules.entries()) {
          const condition = rule.includeSubdomains
            ? {
                resourceTypes: ['main_frame'],
                requestDomains: [rule.hostname],
                regexFilter: '^https://[^/@:]+(?::443)?(?:/|$)',
              }
            : {
                resourceTypes: ['main_frame'],
                requestDomains: [rule.hostname],
                regexFilter: `^https://${rule.hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?::443)?(?:/|$)`,
              };
          rules.push({
            id: DNR_RANGES.restrictionSso[0] + index,
            // This allow must outrank both the Waypoint block (500) and the
            // Flight Path block (1). School policy remains authoritative at
            // 1000 and attention mode at 2000.
            priority: 600,
            action: { type: 'allow' },
            condition,
          });
        }
        const teacherDomains = classroom.blockList?.active
          ? normalizeDomainList(classroom.blockList.blockedDomains, 'teacher block list')
          : [];
        const blockedSsoDomains = teacherDomains.filter((teacherDomain) => (
          authRules.some((authRule) => (
            isHostWithinDomain(authRule.hostname, teacherDomain)
            || isHostWithinDomain(teacherDomain, authRule.hostname)
          ))
        ));
        for (const [index, domain] of blockedSsoDomains.entries()) {
          rules.push({
            id: DNR_RANGES.restrictionSso[0] + 500 + index,
            // A teacher block explicitly covering an authentication host wins
            // over pass-through without changing historical Waypoint-target
            // precedence for unrelated domains.
            priority: 700,
            action: { type: 'block' },
            condition: { resourceTypes: ['main_frame'], requestDomains: [domain] },
          });
        }
      }
    }

    if (rules.filter(rule => rule.condition.regexFilter).length > 800)
      throw preciseRestrictionError('DNR regex budget exceeded', 'DNR_REGEX_BUDGET_EXCEEDED');
    if (rules.some(rule => rule.id < DNR_RANGES.classroom[1] && !isRuleInRange(rule.id, 'classroom')))
      throw preciseRestrictionError('DNR classroom rule ID budget exceeded');
    return rules;
  }

  function tabUrl(tab) {
    return typeof tab?.pendingUrl === 'string' && tab.pendingUrl
      ? tab.pendingUrl
      : typeof tab?.url === 'string'
        ? tab.url
        : '';
  }

  function isHttpTab(tab) {
    return /^https?:\/\//i.test(tabUrl(tab));
  }

  function isProtectedInternalTab(tab) {
    return /^(chrome|chrome-extension|devtools):\/\//i.test(tabUrl(tab));
  }

  function isRestrictionSsoTab(tab) {
    if (!isHttpTab(tab)) return false;
    const host = normalizeDomain(tabUrl(tab));
    return Boolean(host && RESTRICTION_SSO_DOMAINS.some((domain) => (
      isHostWithinDomain(host, domain)
    )));
  }

  function restrictionSafeMonitoringMetadata(state, tab, options = {}) {
    const rawUrl = typeof tab?.url === 'string' ? tab.url : '';
    const rawTitle = typeof tab?.title === 'string' ? tab.title : '';
    const rawFavicon = typeof tab?.favIconUrl === 'string' ? tab.favIconUrl : '';
    const configurableAuthActive = options.restrictionAuthPassThrough === true
      && Boolean(state?.authPassThrough)
      && Boolean(state?.restrictions?.screenLock?.active || state?.restrictions?.flightPath?.active);
    const legacyAuthActive = options.restrictionSsoPassThrough === true
      && state?.deliveryContext?.lateSignInRestrictionSso === true
      && Boolean(state?.restrictions?.screenLock?.active || state?.restrictions?.flightPath?.active);
    const isAuthenticationUrl = configurableAuthActive
      ? Boolean(authPassThroughProfileForUrl(state.authPassThrough, rawUrl))
      : legacyAuthActive && isRestrictionSsoTab({ url: rawUrl });

    if (!isAuthenticationUrl) {
      return {
        url: rawUrl,
        title: rawTitle,
        favicon: rawFavicon,
        redacted: false,
      };
    }

    let safeOrigin = '';
    try {
      const parsed = new URL(rawUrl);
      if (/^https?:$/.test(parsed.protocol)) safeOrigin = `${parsed.origin}/`;
    } catch (_) {
      // Matching requires a valid URL. Keep the fallback empty if parsing
      // behavior ever changes rather than exposing the original value.
    }
    return {
      url: safeOrigin,
      title: 'Signing in',
      favicon: '',
      redacted: true,
    };
  }

  function safeRestrictionTarget(rawUrl, rawDomain, options = {}) {
    const domain = normalizeDomain(rawDomain || rawUrl);
    if (!domain) return null;
    if (options.resource) return isUrlAllowedByRestrictionResource(rawUrl, options.resource) ? rawUrl : null;
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:'
        && !parsed.username
        && !parsed.password
        && (!parsed.port || parsed.port === '443')
        && (options.allowTransientCurrentPage === true || !parsed.search)
        && (options.allowTransientCurrentPage === true || !parsed.hash)
        && normalizeDomain(parsed.hostname) === domain) {
        return parsed.toString();
      }
      return null;
    } catch (_) {
      // A domain-only restriction gets the HTTPS fallback below.
    }
    return `https://${domain}`;
  }

  function isRestrictionDestinationUrl(state, urlValue) {
    if (!state || typeof urlValue !== 'string') return false;
    const restrictions = state.restrictions ?? emptyRestrictions();
    if (restrictions.screenLock?.active) {
      if (restrictions.screenLock.resource)
        return isUrlAllowedByRestrictionResource(urlValue, restrictions.screenLock.resource);
      if (!isHttpTab({ url: urlValue })) return false;
      return isHostWithinDomain(
        normalizeDomain(urlValue),
        normalizeDomain(restrictions.screenLock.domain || restrictions.screenLock.url),
      );
    }
    const host = normalizeDomain(urlValue);
    return Boolean(host && restrictions.flightPath?.active
      && (restrictions.flightPath.allowedDomains.some((domain) => (
        isHostWithinDomain(host, normalizeDomain(domain))
      )) || (restrictions.flightPath.resources || []).some(resource =>
        isUrlAllowedByRestrictionResource(urlValue, resource))));
  }

  function preferredRestrictionTabId(state, tabs, foregroundTabId) {
    const restrictions = state?.restrictions ?? emptyRestrictions();
    const foreground = tabs.find((tab) => tab.id === foregroundTabId);

    if (restrictions.screenLock?.active) {
      const lockedDomain = normalizeDomain(
        restrictions.screenLock.domain || restrictions.screenLock.url
      );
      const compliant = tabs.filter((tab) => isRestrictionDestinationUrl(state, tabUrl(tab)));
      if (foreground && compliant.some((tab) => tab.id === foreground.id)) return foreground.id;
      if (compliant[0]) return compliant[0].id;
      if (foreground && !isProtectedInternalTab(foreground)) return foreground.id;
      return tabs.find((tab) => !isProtectedInternalTab(tab))?.id ?? null;
    }

    if (restrictions.flightPath?.active) {
      const allowedDomains = normalizeDomainList(
        restrictions.flightPath.allowedDomains,
        'Flight Path domains'
      );
      const isAllowed = (tab) => isRestrictionDestinationUrl(state, tabUrl(tab));
      if (foreground && isAllowed(foreground)) return foreground.id;
      const allowed = tabs.find(isAllowed);
      if (allowed) return allowed.id;
      if (foreground && isHttpTab(foreground)) return foreground.id;
      return tabs.find(isHttpTab)?.id ?? null;
    }

    if (foreground && !isProtectedInternalTab(foreground)) return foreground.id;
    for (let index = tabs.length - 1; index >= 0; index -= 1) {
      if (!isProtectedInternalTab(tabs[index])) return tabs[index].id;
    }
    return null;
  }

  function planTabLimitRemovals(state, tabsValue, options = {}) {
    const maxTabs = Number(options.maxTabs);
    if (!Number.isSafeInteger(maxTabs) || maxTabs < 1) return [];
    const tabs = Array.isArray(tabsValue)
      ? tabsValue.filter((tab) => Number.isSafeInteger(tab?.id))
      : [];
    const additionalTabCount = Number.isSafeInteger(options.additionalTabCount)
      && options.additionalTabCount > 0
      ? options.additionalTabCount
      : 0;
    const excess = Math.max(0, tabs.length + additionalTabCount - maxTabs);
    if (excess === 0) return [];

    const foregroundTabId = Number.isSafeInteger(options.foregroundTabId)
      ? options.foregroundTabId
      : tabs.find((tab) => tab.active)?.id;
    const requestedPreserveTabId = Number.isSafeInteger(options.preserveTabId)
      ? options.preserveTabId
      : null;
    const preserveTabId = tabs.some((tab) => tab.id === requestedPreserveTabId)
      ? requestedPreserveTabId
      : preferredRestrictionTabId(state, tabs, foregroundTabId);
    const preserveTabIds = new Set([
      preserveTabId,
      ...(Array.isArray(options.preserveTabIds) ? options.preserveTabIds : []),
    ].filter((tabId) => Number.isSafeInteger(tabId) && tabs.some((tab) => tab.id === tabId)));
    const preferRemoveTabId = Number.isSafeInteger(options.preferRemoveTabId)
      ? options.preferRemoveTabId
      : null;
    const closeable = tabs.filter((tab) =>
      !preserveTabIds.has(tab.id) && !isProtectedInternalTab(tab));
    if (preferRemoveTabId !== null) {
      closeable.sort((left, right) => {
        if (left.id === preferRemoveTabId) return -1;
        if (right.id === preferRemoveTabId) return 1;
        return 0;
      });
    }
    return closeable.slice(0, excess).map((tab) => tab.id);
  }

  function appendTabLimitRemovals(plan, state, tabs, options, preserveTabId = null, preserveTabIds = []) {
    const alreadyRemoved = new Set(plan.removeTabIds);
    const remainingTabs = tabs.filter((tab) => !alreadyRemoved.has(tab.id));
    const limitRemovals = planTabLimitRemovals(state, remainingTabs, {
      maxTabs: options.maxTabs,
      foregroundTabId: options.foregroundTabId,
      preserveTabId,
      preserveTabIds,
      additionalTabCount: plan.createUrl ? 1 : 0,
    });
    for (const tabId of limitRemovals) {
      if (!alreadyRemoved.has(tabId)) {
        alreadyRemoved.add(tabId);
        plan.removeTabIds.push(tabId);
      }
    }
    if (limitRemovals.length > 0) {
      const removedByLimit = new Set(limitRemovals);
      plan.updates = plan.updates.filter((update) => !removedByLimit.has(update.tabId));
    }
    return plan;
  }

  function planClassroomTabReconciliation(state, tabsValue, options = {}) {
    const restrictions = state?.restrictions ?? emptyRestrictions();
    const tabs = Array.isArray(tabsValue)
      ? tabsValue.filter((tab) => Number.isSafeInteger(tab?.id))
      : [];
    const foregroundTabId = Number.isSafeInteger(options.foregroundTabId)
      ? options.foregroundTabId
      : tabs.find((tab) => tab.active)?.id;
    const plan = {
      updates: [],
      removeTabIds: [],
      createUrl: null,
      activateTabId: null,
      focusFallbackUrl: null,
    };
    const authPassThrough = state?.authPassThrough || null;
    const restrictionAuthPassThrough = options.restrictionAuthPassThrough === true
      && Boolean(authPassThrough);
    const legacyRestrictionSsoPassThrough = options.restrictionSsoPassThrough === true
      && state?.deliveryContext?.lateSignInRestrictionSso === true;
    const restrictionSsoPassThrough = restrictionAuthPassThrough || legacyRestrictionSsoPassThrough;
    const authAttempt = options.authPassThroughAttempt;
    const authAttemptInProgress = restrictionAuthPassThrough
      && ['in_progress', 'returning'].includes(authAttempt?.phase);
    const isAuthenticationTab = (tab) => restrictionAuthPassThrough
      ? isAuthPassThroughTab(tab, authPassThrough)
        || (authAttemptInProgress
          && Number.isSafeInteger(authAttempt?.activeTabId)
          && tab.id === authAttempt.activeTabId
          && /^(?:about:blank)?$/i.test(tabUrl(tab)))
      : isRestrictionSsoTab(tab);
    const ssoTabs = restrictionSsoPassThrough ? tabs.filter(isAuthenticationTab) : [];
    // `active` is window-local: every background Chrome window has an active
    // tab, so that bit alone cannot prove an SSO flow is foreground. The
    // caller's fresh last-focused tab and a validated onCreated hint are the
    // only signals allowed to suppress destination activation/focus. Other
    // window-local active SSO tabs are handled by the bounded tab-limit grace
    // below without blocking restriction enforcement in the foreground.
    const requestedSsoPreserveIds = Array.isArray(options.preserveRestrictionSsoTabIds)
      ? options.preserveRestrictionSsoTabIds
      : [];
    // Approved authentication portals remain available for student app
    // selection after bounded authentication bookkeeping has expired. A
    // provider callback is not permission to choose an app for the student.
    const mayProtectAuthenticationTab = restrictionSsoPassThrough;
    const foregroundSsoTabId = mayProtectAuthenticationTab
      ? ssoTabs.find((tab) => tab.id === foregroundTabId)?.id ?? null
      : null;
    const validatedRequestedSsoPreserveIds = requestedSsoPreserveIds.filter((tabId) => (
      Number.isSafeInteger(tabId)
        && mayProtectAuthenticationTab
        && ssoTabs.some((tab) => tab.id === tabId)
    ));
    const focusProtectedSsoTabIds = [...new Set([
      ...(foregroundSsoTabId === null ? [] : [foregroundSsoTabId]),
      ...validatedRequestedSsoPreserveIds,
    ])];
    // Preserve only the exact foreground/hinted authentication flow. When no
    // such flow is known, one sole SSO tab gets a bounded grace exception;
    // multiple window-local `active` SSO tabs are dormant candidates and the
    // numeric tab limit is allowed to recover by closing the excess.
    const preservedSsoTabIds = focusProtectedSsoTabIds.length > 0
      ? focusProtectedSsoTabIds
      : ssoTabs.length === 1
        ? [ssoTabs[0].id]
        : [];
    const visitedSsoHosts = normalizeDomainList(
      Array.isArray(options.visitedSsoHosts) ? options.visitedSsoHosts : [],
      'visited restriction SSO hosts'
    ).filter((host) => RESTRICTION_SSO_DOMAINS.some((domain) => isHostWithinDomain(host, domain)));
    const defaultAuthProfile = restrictionAuthPassThrough
      ? authPassThrough.profiles.find((profile) => profile.id === authPassThrough.defaultProfileId)
      : null;
    const coldSsoStart = restrictionAuthPassThrough
      ? state?.deliveryContext?.lateSignInRestrictionSso === true
        && options.portalFirstLoginHandled !== true
        && authAttemptInProgress
      : legacyRestrictionSsoPassThrough && visitedSsoHosts.length === 0;
    const coldSsoStartUrl = restrictionAuthPassThrough
      ? defaultAuthProfile?.startUrl || null
      : RESTRICTION_SSO_COLD_START_URL;

    if (options.portalFirstOnLogin === true && defaultAuthProfile
      && !restrictions.attentionMode?.active
      && (restrictions.screenLock?.active || restrictions.flightPath?.active)) {
      // Login entry is independent of control revisions. Preserve every
      // teacher-approved page, and reuse a portal tab without reloading it.
      const portalTab = ssoTabs.find((tab) => (
        isDefaultRestrictionPortalUrl(authPassThrough, tabUrl(tab))
      ));
      const destinationTabs = tabs.filter((tab) => (
        isHttpTab(tab) && !isAuthenticationTab(tab) && isRestrictionDestinationUrl(state, tabUrl(tab))
      ));
      const outsideTabs = tabs.filter((tab) => (
        isHttpTab(tab) && !isAuthenticationTab(tab)
        && !destinationTabs.some((destination) => destination.id === tab.id)
      ));
      const retained = portalTab;
      let portalTabId = retained?.id ?? null;
      if (retained) {
        if (retained.id !== foregroundTabId) plan.activateTabId = retained.id;
        plan.removeTabIds.push(...outsideTabs.map((tab) => tab.id));
      } else if (outsideTabs[0]) {
        portalTabId = outsideTabs[0].id;
        plan.updates.push({ tabId: portalTabId, url: defaultAuthProfile.startUrl });
        plan.activateTabId = portalTabId;
        plan.removeTabIds.push(...outsideTabs.slice(1).map((tab) => tab.id));
      } else {
        plan.createUrl = defaultAuthProfile.startUrl;
      }
      plan.focusFallbackUrl = defaultAuthProfile.startUrl;
      return appendTabLimitRemovals(plan, state, tabs, { ...options, foregroundTabId },
        portalTabId, [portalTabId, destinationTabs[0]?.id]);
    }

    // An in-progress authentication flow is intentionally not destination-
    // compliant, but reconciliation must not navigate it or steal focus while
    // a student is signing in. A fresh last-focused exact-SSO tab or an
    // explicitly validated onCreated candidate enters this no-focus branch.
    // Window-local `active` candidates do not suppress a required destination
    // or cold Clever landing; only the bounded preservation rule above can
    // spare them from the numeric limit. DNR and navigation listeners keep
    // those tabs confined to the two exact pass-through domain families.
    if (focusProtectedSsoTabIds.length > 0
      && (restrictions.screenLock?.active || restrictions.flightPath?.active)) {
      const destinationTabs = tabs.filter((tab) => {
        if (!isHttpTab(tab) || isAuthenticationTab(tab)) return false;
        return isRestrictionDestinationUrl(state, tabUrl(tab));
      });
      const destinationUrl = restrictions.screenLock?.active
        ? safeRestrictionTarget(
            restrictions.screenLock.url,
            restrictions.screenLock.domain,
            { allowTransientCurrentPage: options.transientCurrentPage === true, resource: restrictions.screenLock.resource },
          )
        : restrictionLandingUrl(state);
      const nonDestinationTabs = tabs.filter((tab) => (
        !isProtectedInternalTab(tab)
        && !isAuthenticationTab(tab)
        && !destinationTabs.some((destination) => destination.id === tab.id)
        && (restrictions.screenLock?.active || isHttpTab(tab))
      ));
      let preservedDestinationId = destinationTabs[0]?.id ?? null;
      if (preservedDestinationId) {
        plan.removeTabIds.push(...nonDestinationTabs.map((tab) => tab.id));
      } else if (nonDestinationTabs[0] && destinationUrl) {
        preservedDestinationId = nonDestinationTabs[0].id;
        plan.updates.push({ tabId: preservedDestinationId, url: destinationUrl });
        plan.removeTabIds.push(...nonDestinationTabs.slice(1).map((tab) => tab.id));
      }
      return appendTabLimitRemovals(
        plan,
        state,
        tabs,
        { ...options, foregroundTabId },
        preservedDestinationId ?? preservedSsoTabIds[0],
        [...preservedSsoTabIds, preservedDestinationId],
      );
    }

    if (restrictions.screenLock?.active) {
      const destinationUrl = safeRestrictionTarget(
        restrictions.screenLock.url,
        restrictions.screenLock.domain,
        { allowTransientCurrentPage: options.transientCurrentPage === true, resource: restrictions.screenLock.resource },
      );
      const targetUrl = coldSsoStart ? coldSsoStartUrl : destinationUrl;
      if (!targetUrl) throw new Error('screen lock requires a safe navigation target');
      const lockedDomain = normalizeDomain(
        restrictions.screenLock.domain || restrictions.screenLock.url
      );
      const controllable = tabs.filter((tab) => (
        !isProtectedInternalTab(tab) && !(mayProtectAuthenticationTab && isAuthenticationTab(tab))
      ));
      // A cold deferred restriction starts authentication even when an old
      // destination tab happens to remain open from before sign-in. Only a
      // binding-scoped recorded SSO visit turns a later reconciliation warm.
      const compliant = coldSsoStart ? [] : controllable.filter((tab) => isRestrictionDestinationUrl(state, tabUrl(tab)));
      let preservedTabId = null;
      if (compliant.length > 0) {
        // A tab already on the locked domain must never be navigated or
        // reloaded; the lock only removes off-domain tabs around it.
        const compliantIds = new Set(compliant.map((tab) => tab.id));
        const foregroundCompliant = compliant.find((tab) => tab.id === foregroundTabId);
        const retained = foregroundCompliant || compliant[0];
        preservedTabId = retained.id;
        plan.removeTabIds.push(...controllable
          .filter((tab) => !compliantIds.has(tab.id))
          .map((tab) => tab.id));
        if (!foregroundCompliant) {
          plan.activateTabId = retained.id;
          plan.focusFallbackUrl = targetUrl;
        }
      } else {
        const retained = controllable.find((tab) => tab.id === foregroundTabId) || controllable[0];
        if (retained) {
          preservedTabId = retained.id;
          plan.updates.push({ tabId: retained.id, url: targetUrl });
          plan.removeTabIds.push(...controllable
            .filter((tab) => tab.id !== retained.id)
            .map((tab) => tab.id));
          // Even an already-foreground tab is re-activated and verified after
          // navigation so a concurrent close cannot leave no compliant page.
          plan.activateTabId = retained.id;
          plan.focusFallbackUrl = targetUrl;
        } else {
          plan.createUrl = targetUrl;
        }
      }
      return appendTabLimitRemovals(plan, state, tabs, {
        ...options,
        foregroundTabId,
      }, preservedTabId, preservedSsoTabIds);
    }

    if (restrictions.flightPath?.active) {
      const allowedDomains = normalizeDomainList(
        restrictions.flightPath.allowedDomains,
        'Flight Path domains'
      );
      if (allowedDomains.length + (restrictions.flightPath.resources?.length || 0) === 0)
        throw new Error('active Flight Path requires at least one domain or resource');
      const firstUrl = coldSsoStart
        ? coldSsoStartUrl
        : restrictionLandingUrl(state);
      const httpTabs = tabs.filter((tab) => (
        isHttpTab(tab) && !(mayProtectAuthenticationTab && isAuthenticationTab(tab))
      ));
      const allowed = coldSsoStart ? [] : httpTabs.filter((tab) => {
        return isRestrictionDestinationUrl(state, tabUrl(tab));
      });
      const disallowed = httpTabs.filter((tab) => {
        return !isRestrictionDestinationUrl(state, tabUrl(tab));
      });
      const foregroundAllowed = allowed.find((tab) => tab.id === foregroundTabId);
      const foregroundDisallowed = disallowed.find((tab) => tab.id === foregroundTabId);
      let preservedTabId = null;
      if (foregroundAllowed) {
        preservedTabId = foregroundAllowed.id;
        if (disallowed[0]) {
          plan.updates.push({ tabId: disallowed[0].id, url: firstUrl });
          plan.removeTabIds.push(...disallowed.slice(1).map((tab) => tab.id));
        }
      } else if (foregroundDisallowed) {
        preservedTabId = foregroundDisallowed.id;
        plan.updates.push({ tabId: foregroundDisallowed.id, url: firstUrl });
        plan.removeTabIds.push(...disallowed
          .filter((tab) => tab.id !== foregroundDisallowed.id)
          .map((tab) => tab.id));
        plan.activateTabId = foregroundDisallowed.id;
        plan.focusFallbackUrl = firstUrl;
      } else if (allowed[0]) {
        preservedTabId = allowed[0].id;
        plan.removeTabIds.push(...disallowed.map((tab) => tab.id));
        plan.activateTabId = allowed[0].id;
        plan.focusFallbackUrl = firstUrl;
      } else if (disallowed[0]) {
        preservedTabId = disallowed[0].id;
        plan.updates.push({ tabId: disallowed[0].id, url: firstUrl });
        plan.removeTabIds.push(...disallowed.slice(1).map((tab) => tab.id));
        plan.activateTabId = disallowed[0].id;
        plan.focusFallbackUrl = firstUrl;
      } else if (httpTabs.length === 0) {
        plan.createUrl = firstUrl;
      }
      return appendTabLimitRemovals(plan, state, tabs, {
        ...options,
        foregroundTabId,
      }, preservedTabId, preservedSsoTabIds);
    }
    return appendTabLimitRemovals(plan, state, tabs, {
      ...options,
      foregroundTabId,
    });
  }

  function sanitizeNavigation(urlValue, titleValue) {
    if (typeof urlValue !== 'string') return null;
    try {
      const parsed = new URL(urlValue);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      const domain = normalizeDomain(parsed.hostname);
      if (!domain) return null;
      return {
        domain,
        path: boundedString(parsed.pathname || '/', MAX_EVENT_PATH_LENGTH) || '/',
        title: boundedString(titleValue, MAX_EVENT_TITLE_LENGTH),
      };
    } catch (_) {
      return null;
    }
  }

  function sanitizeEventMetadata(type, rawMetadata = {}) {
    const metadata = rawMetadata && typeof rawMetadata === 'object' ? rawMetadata : {};
    if (type === 'tab_changed' || type === 'navigation_changed') {
      return sanitizeNavigation(metadata.url, metadata.title);
    }
    if (type === 'navigation_blocked') {
      const navigation = sanitizeNavigation(metadata.url, metadata.title);
      const policySource = POLICY_SOURCES.has(metadata.policySource) ? metadata.policySource : null;
      return policySource ? { ...(navigation || {}), policySource } : null;
    }
    if (type === 'monitoring_state_changed') {
      const state = boundedString(metadata.state, 32).toLowerCase();
      if (!['active', 'idle', 'off'].includes(state)) return null;
      return { state, reason: boundedString(metadata.reason, 80) };
    }
    if (type.startsWith('restriction_state_')) {
      const restrictionTypes = Array.isArray(metadata.restrictionTypes)
        ? [...new Set(metadata.restrictionTypes
          .map((value) => boundedString(value, 40))
          .filter(Boolean))].slice(0, 10)
        : [];
      const result = {
        revision: finiteInteger(metadata.revision, 0),
        restrictionTypes,
        restrictionType: restrictionTypes.join(',').slice(0, 128),
        outcome: type === 'restriction_state_applied'
          ? 'applied'
          : type === 'restriction_state_failed'
            ? 'failed'
            : 'cleared',
      };
      const reason = boundedString(metadata.reason, 80);
      const errorCode = boundedString(metadata.errorCode, 80);
      if (reason) result.reason = reason;
      if (errorCode) result.errorCode = errorCode;
      return result;
    }
    return null;
  }

  function createMonitoringEvent(input, idFactory = () => crypto.randomUUID(), nowValue = Date.now()) {
    if (!input || !MONITORING_EVENT_TYPES.has(input.type)) return null;
    const metadata = sanitizeEventMetadata(input.type, input.metadata);
    if (!metadata) return null;
    const teachingSessionId = boundedString(input.teachingSessionId, 128) || null;
    const supervisionContextId = boundedString(input.supervisionContextId, 128) || null;
    if (Boolean(teachingSessionId) === Boolean(supervisionContextId)) return null;
    const event = {
      sourceEventId: boundedString(idFactory(), 128),
      schemaVersion: 1,
      type: input.type,
      occurredAt: new Date(timestampMs(input.occurredAt) ?? timestampMs(nowValue) ?? Date.now()).toISOString(),
      teachingSessionId,
      supervisionContextId,
      metadata,
    };
    if (
      input.type === 'tab_changed' ||
      input.type === 'navigation_changed' ||
      input.type === 'navigation_blocked'
    ) {
      // The backend independently sanitizes this already-safe URL. Supplying a
      // top-level URL/title preserves compatibility with v1 ingestion while
      // retaining the structured metadata used by newer consumers.
      if (metadata.domain && metadata.path) {
        event.url = `https://${metadata.domain}${metadata.path}`;
      }
      if (metadata.title) event.title = metadata.title;
    }
    return event;
  }

  function utf8ByteLength(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
    return unescape(encodeURIComponent(text)).length;
  }

  function boundEventOutbox(existing, nextEvent) {
    let entries = Array.isArray(existing) ? existing.filter(Boolean) : [];
    if (nextEvent) entries = [...entries, nextEvent];
    let dropped = 0;
    while (
      entries.length > MAX_EVENT_OUTBOX_ENTRIES ||
      (entries.length > 0 && utf8ByteLength(entries) > MAX_EVENT_OUTBOX_BYTES)
    ) {
      entries.shift();
      dropped += 1;
    }
    return { entries, dropped };
  }

  function acknowledgedMonitoringEventIds(batchValue, responseValue) {
    const batch = Array.isArray(batchValue) ? batchValue : [];
    const results = Array.isArray(responseValue?.results) ? responseValue.results : [];
    const terminalStatuses = new Set(['stored', 'duplicate', 'not_retained']);
    const acknowledged = new Set(results
      .filter((result) => terminalStatuses.has(result?.status))
      .map((result) => result?.sourceEventId)
      .filter((sourceEventId) => typeof sourceEventId === 'string'));
    return batch
      .map((event) => event?.sourceEventId)
      .filter((sourceEventId) => typeof sourceEventId === 'string' && acknowledged.has(sourceEventId));
  }

  function teacherMessageId(rawMessage) {
    if (!rawMessage || typeof rawMessage !== 'object') return '';
    return boundedString(
      rawMessage.id
        ?? rawMessage.messageId
        ?? rawMessage.chatMessageId
        ?? rawMessage.commandId
        ?? rawMessage._msgId,
      MAX_MESSAGE_ID_LENGTH
    );
  }

  function normalizeTeacherMessage(rawMessage, nowValue = Date.now()) {
    const id = teacherMessageId(rawMessage);
    const message = boundedString(rawMessage?.message, MAX_MESSAGE_BODY_LENGTH);
    if (!id || !message) return null;
    return {
      id,
      message,
      ...classroomContext(rawMessage),
      fromName: boundedString(rawMessage?.fromName, 120) || 'Teacher',
      timestamp: positiveTimestamp(rawMessage?.timestamp ?? rawMessage?.createdAt)
        ?? positiveTimestamp(nowValue)
        ?? Date.now(),
      read: rawMessage?.read === true,
      ...(positiveTimestamp(rawMessage?.seenAckedAt)
        ? { seenAckedAt: positiveTimestamp(rawMessage.seenAckedAt) }
        : {}),
      ...(boundedString(rawMessage?.commandId, MAX_MESSAGE_ID_LENGTH)
        ? { commandId: boundedString(rawMessage.commandId, MAX_MESSAGE_ID_LENGTH) }
        : {}),
    };
  }

  function normalizeMessageDedupIds(rawIds) {
    const ids = [];
    const seen = new Set();
    for (const rawId of Array.isArray(rawIds) ? rawIds : []) {
      const id = boundedString(rawId, MAX_MESSAGE_ID_LENGTH);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids.slice(-MAX_MESSAGE_DEDUP_IDS);
  }

  function mergeTeacherMessageInbox(existingMessages, existingSeenIds, incomingMessages, nowValue = Date.now()) {
    const normalizedExisting = (Array.isArray(existingMessages) ? existingMessages : [])
      .map((message) => normalizeTeacherMessage(message, nowValue))
      .filter(Boolean)
      .slice(-MAX_MESSAGE_INBOX_ENTRIES);
    const seenIds = normalizeMessageDedupIds([
      ...(Array.isArray(existingSeenIds) ? existingSeenIds : []),
      ...normalizedExisting.map((message) => message.id),
    ]);
    const seen = new Set(seenIds);
    const addedMessageIds = [];
    const messages = [...normalizedExisting];

    for (const rawMessage of Array.isArray(incomingMessages) ? incomingMessages : []) {
      const message = normalizeTeacherMessage(rawMessage, nowValue);
      if (!message || seen.has(message.id)) continue;
      seen.add(message.id);
      seenIds.push(message.id);
      addedMessageIds.push(message.id);
      messages.push({ ...message, read: false });
    }

    return {
      messages: messages.slice(-MAX_MESSAGE_INBOX_ENTRIES),
      seenIds: normalizeMessageDedupIds(seenIds),
      addedMessageIds,
    };
  }

  root.ClassPilotRuntimeCore = Object.freeze({
    CLASSROOM_STATE_SCHEMA_VERSION,
    CLASSROOM_STATE_MAX_LIFETIME_MS,
    DNR_RANGES,
    RESTRICTION_SSO_DOMAINS,
    RESTRICTION_SSO_COLD_START_URL,
    AUTH_PASS_THROUGH_SCHEMA_VERSION,
    AUTH_PASS_THROUGH_ATTEMPT_TTL_SECONDS,
    MAX_RULE_ENTRIES,
    MAX_EVENT_OUTBOX_ENTRIES,
    MAX_EVENT_OUTBOX_BYTES,
    CONNECTIVITY_HEALTH_SCHEMA_VERSION,
    CONNECTIVITY_UNREACHABLE_AFTER_MS,
    SCREENSHOT_HEALTH_SCHEMA_VERSION,
    MESSAGE_INBOX_SCHEMA_VERSION,
    MAX_MESSAGE_INBOX_ENTRIES,
    MAX_MESSAGE_DEDUP_IDS,
    MONITORING_EVENT_TYPES,
    DELIVERY_POLICIES,
    emptyRestrictions,
    emptyConnectivityHealth,
    normalizeConnectivityHealth,
    connectivityHealthAfterSuccess,
    connectivityHealthAfterFailure,
    connectivityHealthState,
    emptyScreenshotHealth,
    normalizeScreenshotHealth,
    commandDeliveryPolicy,
    commandDeliveryState,
    normalizeDomain,
    isHostWithinDomain,
    isRestrictionSsoTab,
    restrictionSafeMonitoringMetadata,
    normalizeAuthHostname,
    authHostRuleMatchesHost,
    normalizeAuthPassThrough,
    authPassThroughProfileForUrl,
    isDefaultRestrictionPortalUrl,
    isAuthPassThroughTab,
    isRestrictionDestinationUrl,
    safeRestrictionTarget,
    normalizeDomainList,
    normalizeTemporaryAllows,
    normalizeClassroomState,
    normalizePersistedClassroomState,
    isValidRestrictionResource,
    validateAllowedResource: value => isValidRestrictionResource(value) ? { ...value } : null,
    validateAllowedResourceList,
    extractRestrictionResourceIdentity,
    isUrlAllowedByResource: isUrlAllowedByRestrictionResource,
    canonicalUrlForResource,
    restrictionResourceRuleCount,
    restrictionResourceRegexes,
    hasPreciseRestrictions,
    restrictionLandingUrl,
    decideNavigation,
    classroomContext,
    classroomContextKey,
    classroomContexts,
    classroomStateExpiry,
    shouldApplyClassroomState,
    isRuleInRange,
    buildDnrRules,
    isWithinTrackingWindow,
    planTabLimitRemovals,
    planClassroomTabReconciliation,
    sanitizeNavigation,
    sanitizeEventMetadata,
    createMonitoringEvent,
    utf8ByteLength,
    boundEventOutbox,
    acknowledgedMonitoringEventIds,
    teacherMessageId,
    normalizeTeacherMessage,
    normalizeMessageDedupIds,
    mergeTeacherMessageInbox,
  });
})(globalThis);
