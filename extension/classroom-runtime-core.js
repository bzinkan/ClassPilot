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
    if (blockActive && blockedDomains.length === 0) {
      throw new Error('active teacher block list requires at least one valid domain');
    }

    return {
      screenLock: {
        active: screenActive && Boolean(screenDomain),
        url: screenUrl,
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

    return {
      schemaVersion: CLASSROOM_STATE_SCHEMA_VERSION,
      revision,
      teachingSessionId,
      supervisionContextId,
      receivedAt,
      scheduledEndAt,
      hardExpiresAt,
      restrictions,
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
    return finiteInteger(incomingState?.revision, 0) > finiteInteger(currentState?.revision, 0);
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
          priority: 20,
          action: { type: 'block' },
          condition: { resourceTypes: ['main_frame'], requestDomains: [domain] },
        });
      }
    }

    if (ranges.has('temporary')) {
      const temporaryAllows = normalizeTemporaryAllows(classroom.temporaryAllows, nowMs);
      for (const [index, item] of temporaryAllows.entries()) {
        rules.push({
          id: DNR_RANGES.temporary[0] + index,
          priority: 100,
          action: { type: 'allow' },
          condition: { resourceTypes: ['main_frame'], requestDomains: [item.domain] },
        });
      }
    }

    if (ranges.has('restrictionSso')) {
      const restrictionSsoActive = input?.restrictionSsoPassThrough === true
        && classroomState?.deliveryContext?.lateSignInRestrictionSso === true
        && !classroom.attentionMode?.active
        && (classroom.screenLock?.active || classroom.flightPath?.active);
      if (restrictionSsoActive) {
        for (const [index, domain] of RESTRICTION_SSO_DOMAINS.entries()) {
          rules.push({
            id: DNR_RANGES.restrictionSso[0] + index,
            // This allow must outrank both the Waypoint block (500) and the
            // Flight Path block (1). School policy remains authoritative at
            // 1000 and attention mode at 2000.
            priority: 600,
            action: { type: 'allow' },
            condition: { resourceTypes: ['main_frame'], requestDomains: [domain] },
          });
        }
        const teacherDomains = classroom.blockList?.active
          ? normalizeDomainList(classroom.blockList.blockedDomains, 'teacher block list')
          : [];
        const blockedSsoDomains = teacherDomains.filter((teacherDomain) => (
          RESTRICTION_SSO_DOMAINS.some((ssoDomain) => (
            isHostWithinDomain(ssoDomain, teacherDomain)
            || isHostWithinDomain(teacherDomain, ssoDomain)
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

  function safeRestrictionTarget(rawUrl, rawDomain) {
    const domain = normalizeDomain(rawDomain || rawUrl);
    if (!domain) return null;
    try {
      const parsed = new URL(rawUrl);
      if (/^https?:$/.test(parsed.protocol) && normalizeDomain(parsed.hostname) === domain) {
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
      }
    } catch (_) {
      // A domain-only restriction gets the HTTPS fallback below.
    }
    return `https://${domain}`;
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
    const restrictionSsoPassThrough = options.restrictionSsoPassThrough === true
      && state?.deliveryContext?.lateSignInRestrictionSso === true;
    const ssoTabs = restrictionSsoPassThrough ? tabs.filter(isRestrictionSsoTab) : [];
    const foregroundSso = ssoTabs.find((tab) => tab.id === foregroundTabId) || null;
    // `active` is window-local, so a stale last-focused-window query can leave
    // more than one plausible active authentication tab. If the caller has an
    // authoritative foreground SSO observation, retain that exact tab. When
    // it does not, fail safely by retaining every active SSO candidate (or the
    // sole SSO tab) until a later reconciliation can identify the foreground.
    const authoritativeForegroundSso = options.restrictionSsoForegroundAuthoritative === true
      ? foregroundSso
      : null;
    const preservedSsoTabIds = authoritativeForegroundSso
      ? [authoritativeForegroundSso.id]
      : ssoTabs.length === 1
        ? [ssoTabs[0].id]
        : ssoTabs.filter((tab) => tab.active === true).map((tab) => tab.id);
    const visitedSsoHosts = normalizeDomainList(
      Array.isArray(options.visitedSsoHosts) ? options.visitedSsoHosts : [],
      'visited restriction SSO hosts'
    ).filter((host) => RESTRICTION_SSO_DOMAINS.some((domain) => isHostWithinDomain(host, domain)));
    const coldSsoStart = restrictionSsoPassThrough
      && state?.deliveryContext?.lateSignInRestrictionSso === true
      && visitedSsoHosts.length === 0;

    // An active authentication page is intentionally not destination-
    // compliant, but reconciliation must not navigate it or steal focus while
    // a student is signing in. DNR and navigation listeners keep it confined
    // to the two exact pass-through domain families.
    if (foregroundSso && (restrictions.screenLock?.active || restrictions.flightPath?.active)) {
      const destinationTabs = tabs.filter((tab) => {
        if (!isHttpTab(tab) || isRestrictionSsoTab(tab)) return false;
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
          )
        : `https://${normalizeDomainList(
            restrictions.flightPath.allowedDomains,
            'Flight Path domains',
          )[0]}`;
      const nonDestinationTabs = tabs.filter((tab) => (
        !isProtectedInternalTab(tab)
        && !isRestrictionSsoTab(tab)
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
        preservedDestinationId ?? foregroundSso.id,
        [...preservedSsoTabIds, preservedDestinationId],
      );
    }

    if (restrictions.screenLock?.active) {
      const destinationUrl = safeRestrictionTarget(
        restrictions.screenLock.url,
        restrictions.screenLock.domain
      );
      const targetUrl = coldSsoStart ? RESTRICTION_SSO_COLD_START_URL : destinationUrl;
      if (!targetUrl) throw new Error('screen lock requires a safe navigation target');
      const lockedDomain = normalizeDomain(
        restrictions.screenLock.domain || restrictions.screenLock.url
      );
      const controllable = tabs.filter((tab) => (
        !isProtectedInternalTab(tab) && !(restrictionSsoPassThrough && isRestrictionSsoTab(tab))
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
        ? RESTRICTION_SSO_COLD_START_URL
        : `https://${allowedDomains[0]}`;
      const httpTabs = tabs.filter((tab) => (
        isHttpTab(tab) && !(restrictionSsoPassThrough && isRestrictionSsoTab(tab))
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
