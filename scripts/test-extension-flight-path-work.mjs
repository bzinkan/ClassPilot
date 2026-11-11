import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const extension = process.env.CLASSPILOT_EXTENSION_PATH
  ? pathToFileURL(resolve(process.env.CLASSPILOT_EXTENSION_PATH) + sep)
  : new URL('../extension/', import.meta.url);
const coreContext = vm.createContext({ URL, Date, TextEncoder });
vm.runInContext(readFileSync(new URL('classroom-runtime-core.js', extension), 'utf8'), coreContext);
const core = coreContext.ClassPilotRuntimeCore;
const workerSource = readFileSync(new URL('service-worker.js', extension), 'utf8');
const sourceFunction = (start, end) => workerSource.slice(workerSource.indexOf(start), workerSource.indexOf(end, workerSource.indexOf(start)));
const path = { restrictions: { flightPath: { active: true, allowedDomains: ['ixl.com', 'classroom.google.com', 'docs.google.com'] } } };
const work = () => [
  { id: 1, windowId: 1, active: true, url: 'https://ixl.com/math/working' },
  { id: 2, windowId: 2, active: true, url: 'https://classroom.google.com/c/course/a/assignment/details' },
  { id: 3, windowId: 2, active: false, url: 'https://docs.google.com/document/d/abcdefghijklmnopqrstuv/edit' },
];
const plain = value => JSON.parse(JSON.stringify(value));

test('Flight Path preserves every existing allowed work tab above the numeric limit without a duplicate landing', () => {
  const tabs = [...work(), { id: 4, windowId: 1, url: 'https://outside.example/old' }];
  const plan = plain(core.planClassroomTabReconciliation(path, tabs, { foregroundTabId: 1, maxTabs: 2, existingTabLimitMode: 'preserve-existing' }));
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.removeTabIds, [4]);
  assert.equal(plan.activateTabId, null);
  assert.equal(plan.createUrl, null);
  const replay = plain(core.planClassroomTabReconciliation(path, work(), { foregroundTabId: 1, maxTabs: 1 }));
  assert.deepEqual(replay.removeTabIds, [], 'routine snapshot/restore must default to preserving approved work');
});

test('Flight Path brings existing allowed work forward instead of replacing a disallowed foreground tab', () => {
  const plan = plain(core.planClassroomTabReconciliation(path, [...work(), { id: 4, windowId: 3, active: true, url: 'https://outside.example/' }], { foregroundTabId: 4, maxTabs: 1 }));
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.removeTabIds, [4]);
  assert.equal(plan.activateTabId, 1);
});

test('an explicit tab-limit action may reduce existing allowed work', () => {
  const plan = plain(core.planClassroomTabReconciliation(path, work(), { foregroundTabId: 1, maxTabs: 1, existingTabLimitMode: 'enforce-existing' }));
  assert.deepEqual(plan.removeTabIds, [2, 3]);
});

test('removing a Flight Path does not turn routine reconciliation into a destructive tab-limit action', () => {
  const state = { restrictions: { flightPath: { active: false, allowedDomains: [] } } };
  const plan = plain(core.planClassroomTabReconciliation(state, work(), {
    foregroundTabId: 1, maxTabs: 1, existingTabLimitMode: 'preserve-existing',
  }));
  assert.deepEqual(plan.removeTabIds, []);
});

test('routine Focus snapshots still close off-policy tabs while preserving compliant work above the limit', () => {
  const state = { restrictions: { screenLock: { active: true, url: 'https://ixl.com', domain: 'ixl.com' } } };
  const tabs = [...work(), { id: 4, active: false, windowId: 1, url: 'https://ixl.com/math/other-work' }];
  const plan = plain(core.planClassroomTabReconciliation(state, tabs, {
    foregroundTabId: 1, maxTabs: 1, existingTabLimitMode: 'preserve-existing',
  }));
  assert.deepEqual(plan.removeTabIds, [2, 3]);
  assert.deepEqual(plan.updates, []);
});

function reconciliationHarness() {
  const tabs = [...work(), { id: 4, windowId: 1, url: 'https://outside.example/old' }, { id: 5, windowId: 1, url: 'https://outside.example/other' }];
  const changes = [];
  const context = vm.createContext({
    RuntimeCore: core, currentMaxTabs: 1, restrictionAuthAttemptState: null, visitedRestrictionSsoHosts: new Set(),
    CLASSROOM_TAB_OPERATION_TIMEOUT_MS: 5_000, boundedClassroomOperation: async operation => await operation,
    restrictionAuthenticationPassThroughForState: () => false, restrictionAuthPassThroughForState: () => false,
    restrictionSsoPassThroughForState: () => false, restrictionPortalEntryPending: async () => false,
    hasNegotiatedCapability: () => false,
    rememberClassroomTabUpdate: () => {}, rememberClassroomTabRemoval: () => {},
    restrictionAuthenticationTab: () => false, scheduleClassroomStateReconciliationRetry: () => {},
    tabLimitTargetMatches: (left, right) => left?.windowId === right?.windowId && left?.url === right?.url && left?.pendingUrl === right?.pendingUrl,
    markPendingCreatedTabsAsExistingWork: () => {},
    isAuthContextCancellation: () => false, safeDiagnosticError: String, chrome: {}, console,
  });
  vm.runInContext(sourceFunction('async function reconcileExistingTabsForClassroomState(', '\nasync function resolveCurrentUrlMarker'), context);
  return { tabs, changes, context };
}

test('reconciliation rechecks current URLs before closing or navigating a tab', async () => {
  const { tabs, changes, context } = reconciliationHarness();
  let inventoryRead = false;
  await context.reconcileExistingTabsForClassroomState(path, () => {}, null, null, {
    queryTabs: async query => {
      if (!query.active) { inventoryRead = true; return structuredClone(tabs); }
      if (inventoryRead) {
        tabs.find(tab => tab.id === 4).url = 'https://classroom.google.com/c/course/work';
        tabs.find(tab => tab.id === 5).url = 'https://ixl.com/math/new-work';
      }
      return [structuredClone(tabs[0])];
    },
    getTab: async id => structuredClone(tabs.find(tab => tab.id === id)),
    updateTab: async (id, properties) => { changes.push({ id, ...properties }); return { ...tabs.find(tab => tab.id === id), ...properties }; },
    removeTab: async id => changes.push({ closed: id }), refreshTabs: async () => {},
  });
  assert.deepEqual(changes, []);
});

test('a landing update planned from an old outside URL cannot replace newly approved work', async () => {
  const { changes, context } = reconciliationHarness();
  const original = { id: 1, windowId: 1, active: true, url: 'https://outside.example/old' };
  const approved = { ...original, url: 'https://classroom.google.com/c/course/student-work' };
  await context.reconcileExistingTabsForClassroomState(path, () => {}, null, null, {
    queryTabs: async query => [structuredClone(query.active ? approved : original)],
    getTab: async () => structuredClone(approved),
    updateTab: async (id, properties) => { changes.push({ id, ...properties }); return { ...approved, ...properties }; },
    removeTab: async id => changes.push({ closed: id }), refreshTabs: async () => {}, focusWindow: async () => {},
  });
  assert.equal(changes.some(change => change.url || change.closed), false);
});

test('an unchanged cold legacy Focus destination still enters its authorized sign-in portal', async () => {
  const { changes, context } = reconciliationHarness();
  context.restrictionSsoPassThroughForState = () => true;
  const tab = { id: 1, windowId: 1, active: true, url: 'https://ixl.com/math/working' };
  const state = { deliveryContext: { lateSignInRestrictionSso: true }, restrictions: {
    screenLock: { active: true, url: 'https://ixl.com/math/working', domain: 'ixl.com' },
  } };
  await context.reconcileExistingTabsForClassroomState(state, () => {}, null, null, {
    queryTabs: async () => [structuredClone(tab)], getTab: async () => structuredClone(tab),
    updateTab: async (id, properties) => { changes.push({ id, ...properties }); return { ...tab, ...properties }; },
    removeTab: async id => changes.push({ closed: id }), refreshTabs: async () => {}, focusWindow: async () => {},
  });
  assert.equal(changes.some(change => change.url === 'https://clever.com/'), true);
});

function settingsHarness(priorLimit) {
  const tabs = work();
  const removed = [];
  const context = vm.createContext({
    RuntimeCore: core, schoolMaxTabs: priorLimit, currentMaxTabs: priorLimit, teacherMaxTabs: null,
    effectiveTabLimit() { return context.schoolMaxTabs; }, enqueueStudentAuthMutation: async operation => operation(),
    assertAuthenticatedContextCurrent: () => {}, assertCurrentStudentBinding: () => {},
    classroomRestrictionsFromRuntime: () => path.restrictions, restrictionSsoTabLimitPreserveIds: () => [],
    tabLimitTargetMatches: (target, tab) => target.url === tab.url,
    isAuthContextCancellation: () => false, safeDiagnosticError: String, console,
  });
  vm.runInContext(sourceFunction('async function applySchoolTabLimitSettingsSnapshot(', '\nfunction restrictionAuthUrlBlockedByHigherPriority'), context);
  return { context, removed, browser: {
    queryTabs: async query => structuredClone(query.active ? [tabs[0]] : tabs),
    getTab: async id => tabs.find(tab => tab.id === id), removeTab: async id => removed.push(id), notify: async () => {},
  } };
}

test('same school-limit refresh and first-boot baseline preserve existing approved work', async () => {
  for (const previousSchoolLimit of [1, undefined]) {
    const { context, removed, browser } = settingsHarness(previousSchoolLimit ?? null);
    await context.applySchoolTabLimitSettingsSnapshot({ settings: { maxTabsPerStudent: 1 } }, {}, { ...browser, previousSchoolLimit });
    assert.deepEqual(removed, []);
    assert.equal(context.currentMaxTabs, 1);
  }
});

test('a changed verified school limit may reduce existing approved work', async () => {
  const { context, removed, browser } = settingsHarness(4);
  await context.applySchoolTabLimitSettingsSnapshot({ settings: { maxTabsPerStudent: 1 } }, {}, { ...browser, previousSchoolLimit: 4 });
  assert.deepEqual(removed, [2, 3]);
});

test('a new excess tab never starts cleanup of older approved work', async () => {
  const tabs = work();
  const context = vm.createContext({ RuntimeCore: core, screenLocked: false, lockedDomain: null,
    allowedDomains: path.restrictions.flightPath.allowedDomains, currentMaxTabs: 1,
    restrictionSsoPassThroughActive: false, restrictionAuthPassThroughActive: false,
    restrictionAuthAttemptState: null, restrictionAuthPolicyRefreshPending: false,
    runtimeClassroomStateForRules: () => path, globalBlockedDomains: [],
    flightPathIsActive: () => true, restrictionDestinationTab: tab => core.isRestrictionDestinationUrl(path, tab.url),
    restrictionSsoTabLimitPreserveIds: () => [], activeCreatedRestrictionSsoTabId: () => null,
    classroomRestrictionsFromRuntime: () => path.restrictions,
  });
  vm.runInContext(sourceFunction('async function createdTabPolicyDecision(', '\nfunction createdTabRemovalDecisionStillApplies'), context);
  const newlyCreated = { id: 4, windowId: 1, active: false, url: 'https://ixl.com/math/new-tab' };
  const decision = await context.createdTabPolicyDecision(newlyCreated, async () => [...tabs, newlyCreated]);
  assert.equal(decision.policySource, 'tab_limit');
  assert.equal(decision.removalTarget.id, 4);
  assert.equal(decision.reconcileExcessTabs, false);
  context.flightPathIsActive = () => false;
  context.allowedDomains = [];
  const removedState = { restrictions: { flightPath: { active: false, allowedDomains: [] } } };
  context.runtimeClassroomStateForRules = () => removedState;
  context.classroomRestrictionsFromRuntime = () => removedState.restrictions;
  const retainedAfterRemoval = await context.createdTabPolicyDecision(newlyCreated, async () => [...tabs, newlyCreated], {
    preserveExistingWork: true,
  });
  assert.equal(retainedAfterRemoval.policySource, null, 'retained exact callback stays existing after Flight Path removal');
  const genuinelyNewAfterRemoval = await context.createdTabPolicyDecision(newlyCreated, async () => [...tabs, newlyCreated]);
  assert.equal(genuinelyNewAfterRemoval.policySource, 'tab_limit');
});

test('an approved new authentication popup never sacrifices older work to the numeric limit', async () => {
  const tabs = work();
  const popup = { id: 4, windowId: 3, active: true, url: 'https://accounts.google.com/ServiceLogin' };
  const context = vm.createContext({ RuntimeCore: core, screenLocked: false, lockedDomain: null,
    allowedDomains: path.restrictions.flightPath.allowedDomains, currentMaxTabs: 1,
    restrictionSsoPassThroughActive: false, restrictionAuthPassThroughActive: true,
    restrictionAuthAttemptState: { phase: 'in_progress' }, restrictionAuthPolicyRefreshPending: false,
    runtimeClassroomStateForRules: () => path, globalBlockedDomains: [],
    flightPathIsActive: () => true, restrictionDestinationTab: tab => core.isRestrictionDestinationUrl(path, tab.url),
    restrictionSsoTabLimitPreserveIds: () => [1, 4], activeCreatedRestrictionSsoTabId: () => 4,
    restrictionAuthenticationTab: tab => tab.id === 4,
    classroomRestrictionsFromRuntime: () => path.restrictions,
  });
  // The runtime navigation decision is given an approved exact auth envelope.
  context.RuntimeCore = { ...core, decideNavigation: () => ({ allowed: true }) };
  vm.runInContext(sourceFunction('async function createdTabPolicyDecision(', '\nfunction createdTabRemovalDecisionStillApplies'), context);
  const decision = await context.createdTabPolicyDecision(popup, async query => query.active ? [popup] : [...tabs, popup], { createdRestrictionSsoTabId: 4 });
  assert.equal(decision.policySource, null);
  assert.equal(decision.reconcileExcessTabs, false);
});

test('a delayed creation callback retained by Flight Path reconciliation is existing work only under its exact auth binding', () => {
  const context = vm.createContext({ Map, Date, RuntimeCore: core,
    authContextProtocolScope: auth => auth.binding,
  });
  vm.runInContext(sourceFunction('const pendingCreatedTabPolicies = ', '\nfunction restrictionDestinationTab'), context);
  const auth = { binding: 'exact-student-session-A' };
  const record = context.beginPendingCreatedTabPolicy({ id: 2 }, auth);
  context.markPendingCreatedTabsAsExistingWork(path, work(), auth);
  assert.equal(record.preserveExistingWork, true);
  const other = context.beginPendingCreatedTabPolicy({ id: 3 }, { binding: 'exact-student-session-B' });
  context.markPendingCreatedTabsAsExistingWork(path, work(), auth);
  assert.equal(other.preserveExistingWork, false);
  assert.equal(context.finishPendingCreatedTabPolicy(record), true);
  assert.equal(context.finishPendingCreatedTabPolicy(record), false);
});

test('ordinary initial-sync, reconnect and retry reconciliation coordinate pending creation callbacks by default', async () => {
  const { context } = reconciliationHarness();
  let marked = 0;
  context.markPendingCreatedTabsAsExistingWork = () => { marked += 1; };
  await context.reconcileExistingTabsForClassroomState(path, () => {}, {}, null, {
    queryTabs: async query => structuredClone(query.active ? [work()[0]] : work()),
    getTab: async id => work().find(tab => tab.id === id),
    updateTab: async () => { throw new Error('approved work must not be updated'); },
    removeTab: async () => { throw new Error('approved work must not be closed'); }, refreshTabs: async () => {},
  });
  assert.equal(marked, 1);
});
