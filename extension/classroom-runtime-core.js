(function attachClassPilotRuntimeCore(root) {
  'use strict';

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
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(instant);
      const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      const weekdayIndex = WEEKDAYS.indexOf(value.weekday);
      if (weekdayIndex < 0) return true;
      const current = (Number(value.hour) % 24) * 60 + Number(value.minute);
      if (!Number.isFinite(current)) return true;

      if (end > start) {
        return activeDays.has(value.weekday) && current >= start && current <= end;
      }

      // An end at or before the start is an overnight window. The segment
      // after midnight belongs to the prior configured school day.
      const previousWeekday = WEEKDAYS[(weekdayIndex + WEEKDAYS.length - 1) % WEEKDAYS.length];
      return (current >= start && activeDays.has(value.weekday))
        || (current <= end && activeDays.has(previousWeekday));
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
    const flightActive = Boolean(rawFlightPath.active ?? raw.flightPathActive ?? flightDomains.length > 0);
    const screenActive = Boolean(rawScreenLock.active ?? raw.screenLocked ?? screenDomain);
    const blockActive = Boolean(rawBlockList.active ?? blockedDomains.length > 0);
    if (flightActive && flightDomains.length === 0) {
      throw new Error('active Flight Path requires at least one valid domain');
    }
    if (screenActive && !screenDomain) {
      throw new Error('active screen lock requires a valid domain');
    }
    const safeScreenUrl = screenActive
      ? safeRestrictionTarget(screenUrl || `https://${screenDomain}`, screenDomain)
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
      },
      flightPath: {
        active: flightActive && flightDomains.length > 0,
        allowedDomains: flightDomains,
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
      ...(rawDeliveryContext.lateSignInRestrictionSso === true ? {
        deliveryContext: { lateSignInRestrictionSso: true },
      } : {}),
    };
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
        const allowed = screenLockDomains.length > 0
          ? screenLockDomains
          : classroom.flightPath?.active
            ? normalizeDomainList(classroom.flightPath.allowedDomains, 'Flight Path domains')
            : [];
        if (allowed.length > 0) {
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
      try {
        const actual = new URL(urlValue);
        const destination = new URL(restrictions.screenLock.url);
        if (!/^https?:$/.test(actual.protocol) || !/^https?:$/.test(destination.protocol)) return false;
        actual.username = '';
        actual.password = '';
        destination.username = '';
        destination.password = '';
        return actual.toString() === destination.toString();
      } catch (_) {
        return false;
      }
    }
    const host = normalizeDomain(urlValue);
    return Boolean(host && restrictions.flightPath?.active
      && restrictions.flightPath.allowedDomains.some((domain) => (
        isHostWithinDomain(host, normalizeDomain(domain))
      )));
  }

  function preferredRestrictionTabId(state, tabs, foregroundTabId) {
    const restrictions = state?.restrictions ?? emptyRestrictions();
    const foreground = tabs.find((tab) => tab.id === foregroundTabId);

    if (restrictions.screenLock?.active) {
      const lockedDomain = normalizeDomain(
        restrictions.screenLock.domain || restrictions.screenLock.url
      );
      const compliant = tabs.filter((tab) =>
        isHttpTab(tab) && isHostWithinDomain(normalizeDomain(tabUrl(tab)), lockedDomain));
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
      const isAllowed = (tab) => isHttpTab(tab) && allowedDomains.some((allowed) =>
        isHostWithinDomain(normalizeDomain(tabUrl(tab)), allowed));
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
    const authCallbackReady = restrictionAuthPassThrough
      && options.authPassThroughReturnToDestination === true;
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
    const mayProtectAuthenticationTab = (authAttemptInProgress && !authCallbackReady)
      || legacyRestrictionSsoPassThrough;
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
        && authAttemptInProgress
        && !authCallbackReady
      : legacyRestrictionSsoPassThrough && visitedSsoHosts.length === 0;
    const coldSsoStartUrl = restrictionAuthPassThrough
      ? defaultAuthProfile?.startUrl || null
      : RESTRICTION_SSO_COLD_START_URL;

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
        const host = normalizeDomain(tabUrl(tab));
        if (restrictions.screenLock?.active) {
          const domain = normalizeDomain(
            restrictions.screenLock.domain || restrictions.screenLock.url
          );
          return Boolean(host && isHostWithinDomain(host, domain));
        }
        return restrictions.flightPath?.active && restrictions.flightPath.allowedDomains.some((domain) => (
          host && isHostWithinDomain(host, normalizeDomain(domain))
        ));
      });
      const destinationUrl = restrictions.screenLock?.active
        ? safeRestrictionTarget(
            restrictions.screenLock.url,
            restrictions.screenLock.domain,
            { allowTransientCurrentPage: options.transientCurrentPage === true },
          )
        : `https://${normalizeDomainList(
            restrictions.flightPath.allowedDomains,
            'Flight Path domains',
          )[0]}`;
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
        { allowTransientCurrentPage: options.transientCurrentPage === true },
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
      const compliant = coldSsoStart ? [] : controllable.filter((tab) =>
        isHttpTab(tab) && isHostWithinDomain(normalizeDomain(tabUrl(tab)), lockedDomain));
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
      if (allowedDomains.length === 0) throw new Error('active Flight Path requires at least one domain');
      const firstUrl = coldSsoStart
        ? coldSsoStartUrl
        : `https://${allowedDomains[0]}`;
      const httpTabs = tabs.filter((tab) => (
        isHttpTab(tab) && !(mayProtectAuthenticationTab && isAuthenticationTab(tab))
      ));
      const allowed = coldSsoStart ? [] : httpTabs.filter((tab) => {
        const domain = normalizeDomain(tabUrl(tab));
        return domain && allowedDomains.some((allowedDomain) =>
          isHostWithinDomain(domain, allowedDomain));
      });
      const disallowed = httpTabs.filter((tab) => {
        const domain = normalizeDomain(tabUrl(tab));
        return !domain || !allowedDomains.some((allowed) => isHostWithinDomain(domain, allowed));
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
      fromName: boundedString(rawMessage?.fromName, 120) || 'Teacher',
      timestamp: positiveTimestamp(rawMessage?.timestamp ?? rawMessage?.createdAt)
        ?? positiveTimestamp(nowValue)
        ?? Date.now(),
      read: rawMessage?.read === true,
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
    isAuthPassThroughTab,
    isRestrictionDestinationUrl,
    safeRestrictionTarget,
    normalizeDomainList,
    normalizeTemporaryAllows,
    normalizeClassroomState,
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
