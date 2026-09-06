import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface Binding {
  serverOrigin: string; schoolId: string; studentId: string;
  studentSessionId: string; deviceId: string; authContextId: string;
}
interface State {
  revision: number; hardExpiresAt: number; scheduledEndAt: number;
  authPassThrough: {
    policyRevision: number; defaultProfileId: string;
    profiles: Array<{ id: string; startUrl: string; hostRules: Array<{
      hostname: string; includeSubdomains: boolean;
    }> }>;
  } | null;
  restrictions: { attentionMode: { active: boolean }; screenLock: { active: boolean } };
}
interface Entry { phase: string; scopeDigest: string; expiresAt?: number }
interface EntryApi {
  initialize(binding: Binding, state: State): Promise<Entry>;
  read(binding: Binding): Promise<Entry | null>;
  pending(state: State, binding: Binding): Promise<boolean>;
  observe(url: string, state: State, binding: Binding): Promise<void>;
  rememberTab(binding: Binding, tabId: number): Promise<void>;
  cancelTab(binding: Binding, tabId: number): Promise<void>;
  awaitingPolicy(value: boolean): void;
  clear(): Promise<void>;
}
const binding: Binding = {
  serverOrigin: "https://school.fixture.test", schoolId: "school-one",
  studentId: "student-one", studentSessionId: "login-one", deviceId: "device-one",
  authContextId: "auth-one",
};
function snapshot(): State {
  return {
    revision: 7, hardExpiresAt: Date.now() + 600_000, scheduledEndAt: Date.now() + 300_000,
    restrictions: { attentionMode: { active: false }, screenLock: { active: true } },
    authPassThrough: {
      policyRevision: 4, defaultProfileId: "clever",
      profiles: [{ id: "clever", startUrl: "https://district.clever.com/login?school=one", hostRules: [
        { hostname: "clever.com", includeSubdomains: true },
        { hostname: "accounts.google.com", includeSubdomains: false },
      ] }],
    },
  };
}
function harness(storage = new Map<string, unknown>()) {
  const authority = { current: binding, negotiated: true, blocked: false };
  const context = createContext({
    URL, Date, TextEncoder, crypto: webcrypto,
    rawLocalKv: {
      async get(keys: string[]) { return Object.fromEntries(keys.map((key) => [key, storage.get(key)])); },
      async set(values: Record<string, unknown>) {
        for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value));
      },
      async remove(key: string) { storage.delete(key); },
    },
    assertAuthenticatedContextCurrent(candidate: Binding) {
      if (candidate !== authority.current) throw new Error("retired authority");
    },
    hasNegotiatedCapability() { return authority.negotiated; },
    restrictionAuthPassThroughForState(state: State) {
      return Boolean(state?.authPassThrough && state.restrictions.screenLock.active);
    },
    restrictionAuthUrlBlockedByHigherPriority() { return authority.blocked; },
  });
  runInContext(readFileSync(new URL("../../extension/classroom-runtime-core.js", import.meta.url), "utf8"), context);
  const worker = readFileSync(new URL("../../extension/service-worker.js", import.meta.url), "utf8");
  const start = worker.indexOf("let restrictionPortalEntryState = null;");
  const end = worker.indexOf("function enqueueRestrictionAuthAttemptMutation(operation)", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  runInContext(`const RuntimeCore = ClassPilotRuntimeCore;
    const RESTRICTION_PORTAL_ENTRY_STORAGE_KEY = 'restrictionPortalEntryV1';
    ${worker.slice(start, end)}`, context);
  const api: EntryApi = runInContext(`({
    initialize: (binding, state) => setRestrictionPortalEntryPhase(binding, 'pending', { initializeOnly: true, state }),
    read: ensureRestrictionPortalEntryForContext, pending: restrictionPortalEntryPending,
    observe: observeRestrictionPortalEntry, clear: clearRestrictionPortalEntryState,
    rememberTab: rememberRestrictionPortalTab, cancelTab: cancelRestrictionPortalForRemovedTab,
    awaitingPolicy: (value) => { restrictionPortalPolicyRefreshPending = value; },
  })`, context);
  return { api, storage, authority };
}

describe("portal login intent authority and restart lifecycle", () => {
  it("survives a worker restart without raw identity or portal URLs", async () => {
    const first = harness();
    const state = snapshot();
    await first.api.initialize(binding, state);
    const stored = JSON.stringify([...first.storage.values()]);
    for (const secret of [...Object.values(binding), "clever.com", "school=one"]) {
      expect(stored).not.toContain(secret);
    }
    const restored = harness(first.storage);
    expect(await restored.api.pending(state, binding)).toBe(true);
    await restored.api.observe("https://clever.com/in/student", state, binding);
    expect((await restored.api.read(binding))?.phase).toBe("entered");
    expect(await restored.api.pending({ ...state, revision: 8 }, binding)).toBe(false);
    await restored.api.initialize(binding, { ...state, revision: 8 });
    expect((await restored.api.read(binding))?.phase).toBe("entered");
  });

  it("does not mistake a Clever profile's Google dependency for the portal", async () => {
    const { api } = harness();
    const state = snapshot();
    await api.initialize(binding, state);
    await api.observe("https://accounts.google.com/o/oauth2/auth", state, binding);
    expect((await api.read(binding))?.phase).toBe("pending");
    await api.observe("https://district.clever.com/in/student", state, binding);
    expect((await api.read(binding))?.phase).toBe("entered");
  });

  it("waits for fresh policy after restart without interpreting a stripped snapshot as revocation", async () => {
    const { api } = harness();
    const state = snapshot();
    await api.initialize(binding, state);
    api.awaitingPolicy(true);
    expect(await api.pending({ ...state, authPassThrough: null }, binding)).toBe(false);
    expect((await api.read(binding))?.phase).toBe("pending");
    api.awaitingPolicy(false);
    expect(await api.pending(state, binding)).toBe(true);
    expect(await api.pending({ ...state, authPassThrough: null }, binding)).toBe(false);
    expect((await api.read(binding))?.phase).toBe("cancelled");
  });

  it("ignores child popup closure and cancels only removal of the pending portal tab", async () => {
    const { api } = harness();
    const state = snapshot();
    await api.initialize(binding, state);
    await api.rememberTab(binding, 41);
    await api.cancelTab(binding, 42);
    expect(await api.pending(state, binding)).toBe(true);
    await api.cancelTab(binding, 41);
    expect((await api.read(binding))?.phase).toBe("cancelled");
  });

  it.each(["control", "policy", "deadline", "removed", "capability", "blocked"])(
    "cancels pending entry on %s revocation and does not rearm that binding", async (kind) => {
      const { api, authority } = harness();
      const original = snapshot();
      const initial = kind === "deadline" ? { ...original, scheduledEndAt: Date.now() - 1 } : original;
      await api.initialize(binding, initial);
      const next = structuredClone(original);
      if (kind === "control") next.revision++;
      if (kind === "policy" && next.authPassThrough) next.authPassThrough.policyRevision++;
      if (kind === "removed") next.authPassThrough = null;
      if (kind === "capability") authority.negotiated = false;
      if (kind === "blocked") authority.blocked = true;
      expect(await api.pending(next, binding)).toBe(false);
      expect((await api.read(binding))?.phase).toBe("cancelled");
      await api.initialize(binding, original);
      expect((await api.read(binding))?.phase).toBe("cancelled");
    },
  );

  it("pauses for attention and cancels when the teacher changes its revision", async () => {
    const { api } = harness();
    const state = snapshot();
    state.restrictions.attentionMode.active = true;
    await api.initialize(binding, state);
    expect(await api.pending(state, binding)).toBe(false);
    expect((await api.read(binding))?.phase).toBe("pending");
    state.restrictions.attentionMode.active = false;
    state.revision++;
    expect(await api.pending(state, binding)).toBe(false);
    expect((await api.read(binding))?.phase).toBe("cancelled");
  });

  it("rejects retired authority and gives a new login an independent entry", async () => {
    const { api, authority } = harness();
    const state = snapshot();
    const first = await api.initialize(binding, state);
    authority.current = { ...binding, studentSessionId: "login-two", authContextId: "auth-two" };
    await expect(api.observe("https://clever.com/in/student", state, binding)).rejects.toThrow("retired authority");
    expect(await api.read(authority.current)).toBeNull();
    const second = await api.initialize(authority.current, state);
    expect(second.scopeDigest).not.toBe(first.scopeDigest);
    expect(await api.pending(state, authority.current)).toBe(true);
    await api.clear();
    expect(await api.read(authority.current)).toBeNull();
  });
});
