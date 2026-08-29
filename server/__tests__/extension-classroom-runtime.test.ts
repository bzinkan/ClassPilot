import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

function loadRuntimeCore() {
  const source = readFileSync(
    resolve(__dirname, "../../extension/classroom-runtime-core.js"),
    "utf8"
  );
  const context: Record<string, unknown> = {
    URL,
    Date,
    TextEncoder,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
  };
  context.globalThis = context;
  runInNewContext(source, context);
  return context.ClassPilotRuntimeCore as any;
}

const core = loadRuntimeCore();
const NOW = Date.parse("2026-08-13T16:00:00.000Z");

function state(revision: number, overrides: Record<string, unknown> = {}) {
  return core.normalizeClassroomState({
    schemaVersion: 1,
    revision,
    teachingSessionId: "session-1",
    receivedAt: NOW,
    hardExpiresAt: NOW + 24 * 60 * 60 * 1000,
    restrictions: {},
    ...overrides,
  }, NOW);
}

describe("ClassPilot classroom runtime core", () => {
  it("normalizes a complete snapshot and applies the 12-hour absolute cap", () => {
    const normalized = state(7, {
      restrictions: {
        flightPath: { active: true, allowedDomains: ["https://WWW.Example.com/path", "example.com"] },
        blockList: { active: true, blockedDomains: ["lens.google.com"] },
        attentionMode: { active: true, message: "Eyes up" },
        tabLimit: 3,
        temporaryAllows: [{ domain: "lens.google.com", expiresAt: NOW + 60_000 }],
      },
    });

    expect(normalized.revision).toBe(7);
    expect(normalized.restrictions.flightPath.allowedDomains).toEqual(["example.com"]);
    expect(normalized.restrictions.blockList.blockedDomains).toEqual(["lens.google.com"]);
    expect(normalized.restrictions.tabLimit).toBe(3);
    expect(normalized.hardExpiresAt).toBe(NOW + 12 * 60 * 60 * 1000);
  });

  it("uses local receipt time for the absolute cutoff even with a future server timestamp", () => {
    const normalized = state(8, {
      receivedAt: NOW + 30 * 24 * 60 * 60 * 1000,
      hardExpiresAt: NOW + 60 * 24 * 60 * 60 * 1000,
    });
    expect(normalized.hardExpiresAt).toBe(NOW + 12 * 60 * 60 * 1000);
  });

  it("rejects out-of-order and duplicate revisions", () => {
    expect(core.shouldApplyClassroomState(state(9), state(8))).toBe(false);
    expect(core.shouldApplyClassroomState(state(9), state(9))).toBe(false);
    expect(core.shouldApplyClassroomState(state(9), state(10))).toBe(true);
  });

  it("expires at the scheduled end before the hard cap", () => {
    const normalized = state(2, { scheduledEndAt: NOW + 30_000 });
    expect(normalized.scheduledEndAt).toBe(NOW + 30_000);
    expect(core.classroomStateExpiry(normalized, NOW + 29_999).expired).toBe(false);
    expect(core.classroomStateExpiry(normalized, NOW + 30_000)).toEqual({
      expired: true,
      reason: "scheduled_end",
      expiresAt: NOW + 30_000,
    });
  });

  it("composes only the requested DNR half-open ranges", () => {
    const normalized = state(3, {
      restrictions: {
        screenLock: { active: true, domain: "classroom.google.com" },
        blockList: { active: true, blockedDomains: ["chat.openai.com"] },
        temporaryAllows: [{ domain: "chat.openai.com", expiresAt: NOW + 60_000 }],
      },
    });
    const rules = core.buildDnrRules({
      classroomState: normalized,
      globalBlockedDomains: ["lens.google.com"],
    }, ["classroom", "school", "teacher", "temporary"], NOW);

    expect(rules.map((rule: any) => rule.id)).toEqual([1, 2, 1000, 2000, 3000]);
    expect(rules.find((rule: any) => rule.id === 3000)?.action.type).toBe("allow");
    expect(rules.find((rule: any) => rule.id === 1)?.priority)
      .toBeGreaterThan(rules.find((rule: any) => rule.id === 3000)?.priority);
    expect(rules.find((rule: any) => rule.id === 2)?.action.type).toBe("allow");
    expect(core.isRuleInRange(1999, "school")).toBe(true);
    expect(core.isRuleInRange(2000, "school")).toBe(false);
  });

  it("persists Attention Mode as the single classroom navigation rule", () => {
    const normalized = state(4, {
      restrictions: { attentionMode: { active: true, message: "Pause" } },
    });
    const rules = core.buildDnrRules({ classroomState: normalized }, ["classroom"], NOW);
    expect(rules).toEqual([{
      id: 1,
      priority: 2000,
      action: { type: "block" },
      condition: { resourceTypes: ["main_frame"] },
    }]);
  });

  it("keeps Flight Path underneath a foreground screen-lock overlay", () => {
    const normalized = state(4, {
      restrictions: {
        screenLock: {
          active: true,
          url: "https://attention.example/",
          domain: "attention.example",
        },
        flightPath: {
          active: true,
          allowedDomains: ["khanacademy.org", "ixl.com"],
          name: "Math",
        },
      },
    });
    const lockedRules = core.buildDnrRules({ classroomState: normalized }, ["classroom"], NOW);
    expect(lockedRules[0]?.condition.excludedRequestDomains).toEqual(["attention.example"]);

    normalized.restrictions.screenLock.active = false;
    const unlockedRules = core.buildDnrRules({ classroomState: normalized }, ["classroom"], NOW);
    expect(unlockedRules[0]?.condition.excludedRequestDomains).toEqual(["khanacademy.org", "ixl.com"]);
  });

  it("fails safely instead of partially applying more than 1,000 entries", () => {
    expect(() => core.normalizeDomainList(
      Array.from({ length: 1001 }, (_, index) => `domain-${index}.example`),
      "teacher block list"
    )).toThrow("exceeds the 1,000 entry limit");
    expect(() => core.normalizeDomainList(
      ["valid.example", "not a domain"],
      "teacher block list"
    )).toThrow("contains an invalid domain");
  });

  it("keeps school blocks authoritative over temporary teacher allows", () => {
    const normalized = state(5, {
      restrictions: {
        temporaryAllows: [{ domain: "policy.example", expiresAt: NOW + 60_000 }],
      },
    });
    const rules = core.buildDnrRules({
      classroomState: normalized,
      globalBlockedDomains: ["policy.example"],
    }, ["school", "temporary"], NOW);
    const schoolRule = rules.find((rule: any) => rule.id === 1000);
    const temporaryRule = rules.find((rule: any) => rule.id === 3000);
    expect(schoolRule.priority).toBeGreaterThan(temporaryRule.priority);
    expect(schoolRule.action.type).toBe("block");
    expect(temporaryRule.action.type).toBe("allow");
  });

  it("reconciles existing lock tabs while preserving Chrome internal pages", () => {
    const normalized = state(6, {
      restrictions: {
        screenLock: {
          active: true,
          url: "https://Lock.Example/assignment?step=1",
          domain: "lock.example",
        },
      },
    });
    const plan = core.planClassroomTabReconciliation(normalized, [
      { id: 1, active: false, url: "chrome://settings/" },
      { id: 2, active: true, url: "https://outside.example/" },
      { id: 3, active: false, url: "https://another.example/" },
      { id: 4, active: false, url: "file:///tmp/notes.html" },
    ]);

    expect(plan).toEqual({
      updates: [{ tabId: 2, url: "https://lock.example/assignment?step=1" }],
      removeTabIds: [3, 4],
      createUrl: null,
      activateTabId: null,
      focusFallbackUrl: null,
    });
  });

  it("never navigates a tab that is already on the locked domain", () => {
    const normalized = state(6, {
      restrictions: {
        screenLock: {
          active: true,
          url: "https://lock.example/assignment?step=1",
          domain: "lock.example",
        },
      },
    });
    const plan = core.planClassroomTabReconciliation(normalized, [
      { id: 1, active: true, url: "https://www.lock.example/deep/page?q=5" },
      { id: 2, active: false, url: "https://outside.example/" },
      { id: 3, active: false, url: "https://lock.example/other" },
    ]);

    expect(plan).toEqual({
      updates: [],
      removeTabIds: [2],
      createUrl: null,
      activateTabId: null,
      focusFallbackUrl: null,
    });
  });

  it("treats subdomains of the locked domain as compliant", () => {
    const normalized = state(6, {
      restrictions: {
        screenLock: { active: true, url: "https://ixl.com", domain: "ixl.com" },
      },
    });
    const plan = core.planClassroomTabReconciliation(normalized, [
      { id: 1, active: true, url: "https://app.ixl.com/math/grade-5" },
    ]);

    expect(plan).toEqual({
      updates: [],
      removeTabIds: [],
      createUrl: null,
      activateTabId: null,
      focusFallbackUrl: null,
    });
  });

  it("focuses an existing locked-domain tab instead of navigating the active tab", () => {
    const normalized = state(6, {
      restrictions: {
        screenLock: {
          active: true,
          url: "https://lock.example/assignment",
          domain: "lock.example",
        },
      },
    });
    const plan = core.planClassroomTabReconciliation(normalized, [
      { id: 1, active: true, url: "https://outside.example/video" },
      { id: 2, active: false, url: "https://lock.example/work-in-progress" },
    ]);

    expect(plan).toEqual({
      updates: [],
      removeTabIds: [1],
      createUrl: null,
      activateTabId: 2,
      focusFallbackUrl: "https://lock.example/assignment",
    });
  });

  it("still navigates the active tab when no tab is on the locked domain", () => {
    const normalized = state(6, {
      restrictions: {
        screenLock: {
          active: true,
          url: "https://lock.example/assignment",
          domain: "lock.example",
        },
      },
    });
    const plan = core.planClassroomTabReconciliation(normalized, [
      { id: 1, active: false, url: "https://evillock.example/phish" },
      { id: 2, active: true, url: "https://outside.example/" },
    ]);

    expect(plan).toEqual({
      updates: [{ tabId: 2, url: "https://lock.example/assignment" }],
      removeTabIds: [1],
      createUrl: null,
      activateTabId: null,
      focusFallbackUrl: null,
    });
  });

  it("keeps allowed Flight Path tabs and replaces only disallowed web tabs", () => {
    const normalized = state(7, {
      restrictions: {
        flightPath: { active: true, allowedDomains: ["allowed.example"] },
      },
    });
    const plan = core.planClassroomTabReconciliation(normalized, [
      { id: 1, active: false, url: "chrome://version/" },
      { id: 2, active: false, url: "https://allowed.example/work" },
      { id: 3, active: true, url: "https://outside.example/answer" },
      { id: 4, active: false, url: "https://other.example/" },
    ]);

    expect(plan).toEqual({
      updates: [{ tabId: 3, url: "https://allowed.example" }],
      removeTabIds: [4],
      createUrl: null,
      activateTabId: null,
      focusFallbackUrl: null,
    });
  });

  it("treats subdomains of Flight Path domains as allowed", () => {
    const normalized = state(7, {
      restrictions: {
        flightPath: { active: true, allowedDomains: ["allowed.example"] },
      },
    });
    const untouched = core.planClassroomTabReconciliation(normalized, [
      { id: 1, active: true, url: "https://app.allowed.example/lesson/4" },
    ]);
    expect(untouched).toEqual({
      updates: [],
      removeTabIds: [],
      createUrl: null,
      activateTabId: null,
      focusFallbackUrl: null,
    });

    const mixed = core.planClassroomTabReconciliation(normalized, [
      { id: 1, active: true, url: "https://app.allowed.example/lesson/4" },
      { id: 2, active: false, url: "https://notallowed.example/" },
    ]);
    expect(mixed).toEqual({
      updates: [{ tabId: 2, url: "https://allowed.example" }],
      removeTabIds: [],
      createUrl: null,
      activateTabId: null,
      focusFallbackUrl: null,
    });
  });

  it("matches hosts within a domain without accepting lookalike suffixes", () => {
    expect(core.isHostWithinDomain("ixl.com", "ixl.com")).toBe(true);
    expect(core.isHostWithinDomain("app.ixl.com", "ixl.com")).toBe(true);
    expect(core.isHostWithinDomain("es.app.ixl.com", "ixl.com")).toBe(true);
    expect(core.isHostWithinDomain("IXL.com.", "ixl.com")).toBe(true);
    expect(core.isHostWithinDomain("evilixl.com", "ixl.com")).toBe(false);
    expect(core.isHostWithinDomain("ixl.com", "app.ixl.com")).toBe(false);
    expect(core.isHostWithinDomain("ixl.com.evil.example", "ixl.com")).toBe(false);
    expect(core.isHostWithinDomain("", "ixl.com")).toBe(false);
    expect(core.isHostWithinDomain(null, "ixl.com")).toBe(false);
    expect(core.isHostWithinDomain("ixl.com", null)).toBe(false);
  });

  it("treats corrupted snapshots as invalid", () => {
    expect(() => core.normalizeClassroomState(null, NOW)).toThrow("must be an object");
    expect(() => core.normalizeClassroomState({
      revision: 1,
      teachingSessionId: "one",
      supervisionContextId: "two",
    }, NOW)).toThrow("cannot contain both");
    expect(() => core.normalizeClassroomState({
      schemaVersion: 2,
      revision: 1,
    }, NOW)).toThrow("unsupported classroomState schema version");
    expect(() => core.normalizeClassroomState({
      schemaVersion: 1,
      revision: -1,
    }, NOW)).toThrow("revision must be a non-negative safe integer");
    expect(() => core.normalizeClassroomState({
      schemaVersion: 1,
      revision: 1,
      teachingSessionId: "session-1",
      hardExpiresAt: "corrupt",
      restrictions: { blockList: { active: true, blockedDomains: ["example.com"] } },
    }, NOW)).toThrow("requires a valid hard expiry");
    expect(() => core.normalizeClassroomState({
      schemaVersion: 1,
      revision: 1,
      teachingSessionId: "session-1",
      hardExpiresAt: NOW + 60_000,
      scheduledEndAt: "corrupt",
      restrictions: {},
    }, NOW)).toThrow("scheduled end must be a valid timestamp");
  });
});

describe("ClassPilot tracking windows", () => {
  const overnight = {
    enabled: true,
    startTime: "22:00",
    endTime: "06:00",
    timezone: "America/New_York",
    activeDays: ["Monday"],
  };

  it("attributes the after-midnight overnight segment to the previous school day", () => {
    expect(core.isWithinTrackingWindow({
      ...overnight,
      now: Date.parse("2026-08-18T03:00:00.000Z"), // Monday 23:00 EDT
    })).toBe(true);
    expect(core.isWithinTrackingWindow({
      ...overnight,
      now: Date.parse("2026-08-18T07:00:00.000Z"), // Tuesday 03:00 EDT
    })).toBe(true);
    expect(core.isWithinTrackingWindow({
      ...overnight,
      now: Date.parse("2026-08-18T11:00:00.000Z"), // Tuesday 07:00 EDT
    })).toBe(false);
  });

  it("does not grant an overnight window starting on an inactive day", () => {
    expect(core.isWithinTrackingWindow({
      ...overnight,
      now: Date.parse("2026-08-19T03:00:00.000Z"), // Tuesday 23:00 EDT
    })).toBe(false);
  });
});

describe("ClassPilot connectivity and screenshot diagnostics", () => {
  it("moves from connected to unreachable at the exact 60-second boundary", () => {
    const health = core.connectivityHealthAfterSuccess(null, NOW);
    expect(core.connectivityHealthState(health, NOW + 59_999)).toMatchObject({
      state: "connected",
      boundaryAt: NOW + 60_000,
    });
    expect(core.connectivityHealthState(health, NOW + 60_000)).toMatchObject({
      state: "unreachable",
      boundaryAt: NOW + 60_000,
    });
  });

  it("shows the first retryable failure as reconnecting and clears it on recovery", () => {
    const connected = core.connectivityHealthAfterSuccess(null, NOW);
    const reconnecting = core.connectivityHealthAfterFailure(
      connected,
      "server_unavailable",
      NOW + 10_000
    );
    expect(core.connectivityHealthState(reconnecting, NOW + 10_000).state).toBe("reconnecting");
    expect(reconnecting).toEqual({
      schemaVersion: 1,
      lastSuccessAt: NOW,
      lastFailureAt: NOW + 10_000,
      failureStartedAt: NOW + 10_000,
      consecutiveFailures: 1,
      errorCategory: "server_unavailable",
    });

    const restored = core.connectivityHealthAfterSuccess(reconnecting, NOW + 11_000);
    expect(core.connectivityHealthState(restored, NOW + 11_000).state).toBe("connected");
    expect(restored.consecutiveFailures).toBe(0);
    expect(restored.errorCategory).toBeNull();
  });

  it("persists only bounded connectivity and screenshot diagnostic fields", () => {
    const connectivity = core.normalizeConnectivityHealth({
      schemaVersion: 1,
      lastSuccessAt: NOW,
      lastFailureAt: NOW + 1,
      failureStartedAt: NOW + 1,
      consecutiveFailures: 1,
      errorCategory: "student_switched_wifi_off",
      url: "https://private.example/answer",
    });
    expect(Object.keys(connectivity)).toEqual([
      "schemaVersion",
      "lastSuccessAt",
      "lastFailureAt",
      "failureStartedAt",
      "consecutiveFailures",
      "errorCategory",
    ]);
    expect(connectivity.errorCategory).toBeNull();

    const screenshot = core.normalizeScreenshotHealth({
      schemaVersion: 1,
      lastAttemptAt: NOW,
      lastSuccessAt: NOW - 1,
      lastErrorAt: NOW - 2,
      lastErrorCode: "capture_failed",
      screenshot: "data:image/jpeg;base64,private",
    });
    expect(screenshot).toEqual({
      schemaVersion: 1,
      lastAttemptAt: NOW,
      lastSuccessAt: NOW - 1,
      lastErrorAt: NOW - 2,
      lastErrorCode: "capture_failed",
    });
    expect(JSON.stringify(screenshot)).not.toContain("data:image");
  });
});

describe("ClassPilot transient command delivery", () => {
  it("rejects transient commands at the deadline but accepts them immediately before it", () => {
    const command = { type: "open-tab" };
    const envelope = {
      deliveryPolicy: "transient_action",
      expiresAt: new Date(NOW + 15_000).toISOString(),
    };
    expect(core.commandDeliveryState(command, envelope, NOW + 14_999)).toEqual({
      commandType: "open-tab",
      deliveryPolicy: "transient_action",
      expiresAt: NOW + 15_000,
      expired: false,
    });
    expect(core.commandDeliveryState(command, envelope, NOW + 15_000).expired).toBe(true);
  });

  it("does not confuse a persistent temporary-allow expiry with command delivery expiry", () => {
    expect(core.commandDeliveryState({
      type: "temp-unblock",
      data: { expiresAt: NOW - 1 },
    }, {}, NOW)).toEqual({
      commandType: "temp-unblock",
      deliveryPolicy: "persistent_control",
      expiresAt: null,
      expired: false,
    });
    expect(core.commandDeliveryPolicy("teacher-message")).toBe("durable_message");
    expect(core.commandDeliveryPolicy("student-sign-out")).toBe("server_authoritative");
    expect(core.commandDeliveryPolicy("close-tab")).toBe("transient_action");
  });
});

describe("ClassPilot durable teacher-message inbox", () => {
  it("deduplicates heartbeat retries by stable id while retaining genuine same-text messages", () => {
    const first = core.mergeTeacherMessageInbox([], [], [
      { id: "message-1", message: "Bring your notebook" },
      { id: "message-1", message: "Duplicate transport copy" },
      { id: "message-2", message: "Bring your notebook" },
      { message: "Missing stable id" },
    ], NOW);

    expect(first.messages.map((message: any) => message.id)).toEqual(["message-1", "message-2"]);
    expect(first.messages.map((message: any) => message.message)).toEqual([
      "Bring your notebook",
      "Bring your notebook",
    ]);
    expect(first.addedMessageIds).toEqual(["message-1", "message-2"]);

    const afterRestart = core.mergeTeacherMessageInbox(first.messages, first.seenIds, [
      { id: "message-1", message: "Bring your notebook" },
      { commandId: "command-3", message: "New after restart" },
    ], NOW + 1_000);
    expect(afterRestart.messages.map((message: any) => message.id)).toEqual([
      "message-1",
      "message-2",
      "command-3",
    ]);
    expect(afterRestart.addedMessageIds).toEqual(["command-3"]);
  });

  it("bounds both the displayed inbox and persistent dedup ledger", () => {
    const merged = core.mergeTeacherMessageInbox([], [], Array.from({ length: 550 }, (_, index) => ({
      id: `message-${index}`,
      message: `Message ${index}`,
    })), NOW);

    expect(merged.messages).toHaveLength(50);
    expect(merged.messages[0].id).toBe("message-500");
    expect(merged.seenIds).toHaveLength(500);
    expect(merged.seenIds[0]).toBe("message-50");
    expect(merged.addedMessageIds).toHaveLength(550);
  });

  it("stores only bounded message fields and never arbitrary image data", () => {
    const normalized = core.normalizeTeacherMessage({
      id: "message-safe",
      message: "Teacher note",
      fromName: "Teacher",
      screenshot: "data:image/jpeg;base64,private",
      arbitrary: { answer: "secret" },
    }, NOW);

    expect(normalized).toEqual({
      id: "message-safe",
      message: "Teacher note",
      fromName: "Teacher",
      timestamp: NOW,
      read: false,
    });
    expect(JSON.stringify(normalized)).not.toContain("data:image");
    expect(JSON.stringify(normalized)).not.toContain("secret");
  });
});

describe("ClassPilot monitoring event privacy", () => {
  it("removes credentials, query strings, and fragments from navigation metadata", () => {
    const event = core.createMonitoringEvent({
      type: "navigation_changed",
      teachingSessionId: "session-1",
      metadata: {
        url: "https://student:secret@Example.com/assignment/7?answer=42#private",
        title: "Assignment",
        arbitrary: "must not survive",
      },
    }, () => "event-1", NOW);

    expect(event.metadata).toEqual({
      domain: "example.com",
      path: "/assignment/7",
      title: "Assignment",
    });
    expect(event.url).toBe("https://example.com/assignment/7");
    expect(event.title).toBe("Assignment");
    expect(JSON.stringify(event)).not.toContain("answer");
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toContain("arbitrary");
  });

  it("emits scalar restriction compatibility fields without arbitrary metadata", () => {
    const event = core.createMonitoringEvent({
      type: "restriction_state_failed",
      teachingSessionId: "session-1",
      metadata: {
        revision: 8,
        restrictionTypes: ["flight_path", "block_list"],
        errorCode: "DnrApplyError",
        internalDetails: "must not survive",
      },
    }, () => "event-5", NOW);
    expect(event.metadata).toEqual({
      revision: 8,
      restrictionTypes: ["flight_path", "block_list"],
      restrictionType: "flight_path,block_list",
      outcome: "failed",
      errorCode: "DnrApplyError",
    });
    expect(JSON.stringify(event)).not.toContain("internalDetails");
  });

  it("requires an allowed policy source for blocked navigation", () => {
    expect(core.createMonitoringEvent({
      type: "navigation_blocked",
      metadata: { url: "https://example.com", policySource: "made_up" },
    }, () => "event-2", NOW)).toBeNull();
    expect(core.createMonitoringEvent({
      type: "navigation_blocked",
      teachingSessionId: "session-1",
      metadata: { policySource: "tab_limit" },
    }, () => "event-2b", NOW)).toMatchObject({
      type: "navigation_blocked",
      metadata: { policySource: "tab_limit" },
    });
  });

  it("does not retain an event without exactly one authorized scope", () => {
    expect(core.createMonitoringEvent({
      type: "tab_changed",
      metadata: { url: "https://example.com", title: "Example" },
    }, () => "event-3", NOW)).toBeNull();
    expect(core.createMonitoringEvent({
      type: "tab_changed",
      teachingSessionId: "session-1",
      supervisionContextId: "coverage-1",
      metadata: { url: "https://example.com", title: "Example" },
    }, () => "event-4", NOW)).toBeNull();
  });

  it("bounds the outbox by entry count and reports dropped oldest events", () => {
    const initial = Array.from({ length: 500 }, (_, index) => ({ sourceEventId: `event-${index}` }));
    const bounded = core.boundEventOutbox(initial, { sourceEventId: "event-new" });
    expect(bounded.entries).toHaveLength(500);
    expect(bounded.entries[0].sourceEventId).toBe("event-1");
    expect(bounded.entries.at(-1).sourceEventId).toBe("event-new");
    expect(bounded.dropped).toBe(1);
  });

  it("removes only terminal per-event ingestion acknowledgements", () => {
    const batch = [
      { sourceEventId: "event-stored" },
      { sourceEventId: "event-duplicate" },
      { sourceEventId: "event-not-retained" },
      { sourceEventId: "event-missing" },
    ];
    expect(core.acknowledgedMonitoringEventIds(batch, {
      results: [
        { sourceEventId: "event-stored", status: "stored" },
        { sourceEventId: "event-duplicate", status: "duplicate" },
        { sourceEventId: "event-not-retained", status: "not_retained" },
        { sourceEventId: "event-missing", status: "unknown" },
        { sourceEventId: "not-in-batch", status: "stored" },
      ],
    })).toEqual([
      "event-stored",
      "event-duplicate",
      "event-not-retained",
    ]);
    expect(core.acknowledgedMonitoringEventIds(batch, null)).toEqual([]);
  });
});
