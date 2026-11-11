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
    capturePendingCreatedTabCandidates: () => new Set(),
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

function pendingCreationHarness() {
  const harness = reconciliationHarness();
  harness.context.authContextProtocolScope = auth => auth.binding;
  vm.runInContext(sourceFunction('const pendingCreatedTabPolicies = ', '\nfunction restrictionDestinationTab'), harness.context);
  return harness;
}

test('queued state adoption freezes pending callbacks at request entry', async () => {
  const { context } = pendingCreationHarness();
  const auth = { binding: 'exact-session-A' };
  const old = context.beginPendingCreatedTabPolicy({ id: 2 }, auth);
  let releaseQueue;
  const gate = new Promise(resolve => { releaseQueue = resolve; });
  let received;
  context.enqueueClassroomStateOperation = async operation => { await gate; return operation(); };
  context.applyClassroomStateNow = async (_state, options) => { received = options; };
  vm.runInContext(sourceFunction('function applyClassroomState(rawState', '\nasync function expireClassroomState'), context);
  const application = context.applyClassroomState(path, { authContext: auth });
  const late = context.beginPendingCreatedTabPolicy({ id: 3 }, auth);
  releaseQueue(); await application;
  context.markPendingCreatedTabsAsExistingWork(path, work(), auth, received.pendingCreatedTabCandidates);
  assert.equal(old.preserveExistingWork, true);
  assert.equal(late.preserveExistingWork, false);
});

test('post-ACK side effects cannot grandfather a new callback created while the attention broadcast waits', async () => {
  const { context } = pendingCreationHarness();
  const state = { revision: 2, restrictions: { flightPath: { active: false, allowedDomains: [] }, attentionMode: { active: false } } };
  const auth = { binding: 'exact-session-A' }, owner = {};
  const old = context.beginPendingCreatedTabPolicy({ id: 2 }, auth);
  let releaseBroadcast, enteredBroadcast, completed;
  const gate = new Promise(resolve => { releaseBroadcast = resolve; });
  const entered = new Promise(resolve => { enteredBroadcast = resolve; });
  const finished = new Promise(resolve => { completed = resolve; });
  const tabs = work();
  Object.assign(context, {
    currentClassroomState: state, classroomRuntimeOwner: owner, classroomRuntimeIsOwnedBy: value => value === owner,
    assertAuthenticatedContextCurrent: () => {}, assertCurrentStudentBinding: () => ({}), assertBindingMatchesAuthContext: () => {},
    authContextSuperseded: () => new Error('retired'),
    broadcastToAllTabsForAuth: async () => { enteredBroadcast(); await gate; },
    raiseDeferredTeacherMessageNotification: async () => {}, refreshTabCache: async () => { completed(); },
    restrictionAuthPolicyRefreshPending: false, restrictionPortalPolicyRefreshPending: false,
    CLASSROOM_STATE_RECONCILE_ALARM: 'reconcile',
    chrome: { tabs: { query: async query => structuredClone(query.active ? [tabs[0]] : tabs),
      get: async id => tabs.find(tab => tab.id === id), update: async () => { throw new Error('unexpected update'); },
      remove: async () => { throw new Error('unexpected removal'); } }, alarms: { clear: async () => {} } },
  });
  vm.runInContext(sourceFunction('async function reconcileClassroomStateTabsBestEffort(', '\nasync function reconcileExistingTabsForClassroomState'), context);
  vm.runInContext(sourceFunction('function scheduleClassroomStateSideEffects(', '\nasync function failPrivateRetiredClassroomRuntime'), context);
  context.scheduleClassroomStateSideEffects(state, { authContext: auth, runtimeOwner: owner });
  await entered;
  const late = context.beginPendingCreatedTabPolicy({ id: 4 }, auth);
  tabs.push({ id: 4, windowId: 1, active: false, url: 'https://outside.example/truly-new' });
  releaseBroadcast(); await finished;
  assert.equal(old.preserveExistingWork, true, 'callback predating the state request remains existing work');
  assert.equal(late.preserveExistingWork, false, 'callback created after the state request must remain new');
});

test('direct reconciliation freezes callbacks before its asynchronous tab inventory', async () => {
  const { context } = pendingCreationHarness();
  const auth = { binding: 'exact-session-A' };
  const old = context.beginPendingCreatedTabPolicy({ id: 2 }, auth);
  let releaseQuery, queryStarted;
  const gate = new Promise(resolve => { releaseQuery = resolve; });
  const started = new Promise(resolve => { queryStarted = resolve; });
  const application = context.reconcileExistingTabsForClassroomState(path, () => {}, auth, null, {
    queryTabs: async query => {
      if (!query.active) { queryStarted(); await gate; return work(); }
      return [work()[0]];
    }, getTab: async id => work().find(tab => tab.id === id), refreshTabs: async () => {},
  });
  await started;
  const late = context.beginPendingCreatedTabPolicy({ id: 3 }, auth);
  releaseQuery(); await application;
  assert.equal(old.preserveExistingWork, true);
  assert.equal(late.preserveExistingWork, false);
});

test('retry alarms freeze callbacks before waiting for restore and the mutation queues', async () => {
  const { context } = pendingCreationHarness();
  const auth = { binding: 'exact-session-A' };
  const old = context.beginPendingCreatedTabPolicy({ id: 2 }, auth);
  let releaseRestore, received;
  const gate = new Promise(resolve => { releaseRestore = resolve; });
  Object.assign(context, { currentClassroomState: path, classroomRuntimeOwner: {},
    enqueueStudentAuthMutation: async operation => operation(), enqueueClassroomStateOperation: async operation => operation(),
    assertAuthenticatedContextCurrent: () => {}, createClassroomTabMutationJournal: () => ({}),
    transientCurrentPageRestrictionActive: false,
  });
  vm.runInContext(sourceFunction('async function handleClassroomStateReconcileAlarm(', '\nasync function reconcileClassroomStateTabsBestEffort'), context);
  const application = context.handleClassroomStateReconcileAlarm({ authContext: auth, restorePromise: gate,
    reconcile: async (_state, options) => { received = options; } });
  const late = context.beginPendingCreatedTabPolicy({ id: 3 }, auth);
  releaseRestore(); await application;
  context.markPendingCreatedTabsAsExistingWork(path, work(), auth, received.pendingCreatedTabCandidates);
  assert.equal(old.preserveExistingWork, true);
  assert.equal(late.preserveExistingWork, false);
});

test('an already-expired adoption keeps its original pending-callback boundary through expiry cleanup', async () => {
  const { context } = pendingCreationHarness();
  const auth = { binding: 'exact-session-A' };
  const old = context.beginPendingCreatedTabPolicy({ id: 2 }, auth);
  let releaseValidation, validationStarted, received;
  const gate = new Promise(resolve => { releaseValidation = resolve; });
  const started = new Promise(resolve => { validationStarted = resolve; });
  Object.assign(context, {
    exactStudentBinding: () => ({ bindingVersion: 1, studentId: 'A', studentSessionId: 'session-A' }),
    createClassroomRuntimeOwner: () => ({}), createClassroomTabMutationJournal: () => ({}),
    currentStudentControlRevision: () => 1, assertAuthenticatedContextCurrent: () => {},
    resolveCurrentUrlMarker: async state => { validationStarted(); await gate; return state; },
    validateRestrictionSsoDeliveryContext: async () => null, validateRestrictionAuthPassThroughContext: async () => {},
    nextRestrictionAuthPolicyFence: async () => null, prepareFocusAssignment: async () => null,
    currentClassroomState: null, restrictionPortalPolicyRefreshPending: false, transientCurrentPageRestrictionActive: false,
    restrictionAuthPolicyFenceState: null, restrictionAuthPolicyRefreshPending: false,
    retireScreenshotAuthorityForClassroomChange: () => {}, scheduleEventHeartbeat: () => {},
    expireClassroomState: async (_reason, options) => { received = options; },
  });
  vm.runInContext(sourceFunction('async function applyClassroomStateNow(', '\nfunction applyClassroomState(rawState'), context);
  const expired = { schemaVersion: 1, revision: 2, teachingSessionId: 'expired-class',
    hardExpiresAt: Date.now() - 1_000, restrictions: path.restrictions };
  const application = context.applyClassroomStateNow(expired, { authContext: auth });
  await started;
  const late = context.beginPendingCreatedTabPolicy({ id: 3 }, auth);
  releaseValidation(); await application;
  context.markPendingCreatedTabsAsExistingWork(path, work(), auth, received.pendingCreatedTabCandidates);
  assert.equal(old.preserveExistingWork, true);
  assert.equal(late.preserveExistingWork, false);
});

test('queued expiry checks carry the request boundary through the expiry reducer', async () => {
  const { context } = pendingCreationHarness();
  const auth = { binding: 'exact-session-A' };
  const old = context.beginPendingCreatedTabPolicy({ id: 2 }, auth);
  let releaseQueue, received;
  const gate = new Promise(resolve => { releaseQueue = resolve; });
  Object.assign(context, {
    currentClassroomState: core.normalizeClassroomState({ schemaVersion: 1, revision: 2,
      teachingSessionId: 'expired-class', hardExpiresAt: Date.now() - 1_000, restrictions: path.restrictions }),
    captureAuthenticatedContext: () => auth, assertAuthenticatedContextCurrent: () => {},
    enqueueStudentAuthMutation: async operation => { await gate; return operation(); },
    enqueueClassroomStateOperation: async operation => operation(),
    expireClassroomState: async (_reason, options) => { received = options; },
  });
  vm.runInContext(sourceFunction('async function checkClassroomStateExpiryNow(', '\nfunction storedClassroomStateMatches'), context);
  vm.runInContext(sourceFunction('function checkClassroomStateExpiry()', '\nfunction assertRemoteCommandExecutionContextCurrent'), context);
  const application = context.checkClassroomStateExpiry();
  const late = context.beginPendingCreatedTabPolicy({ id: 3 }, auth);
  releaseQueue(); await application;
  context.markPendingCreatedTabsAsExistingWork(path, work(), auth, received.pendingCreatedTabCandidates);
  assert.equal(old.preserveExistingWork, true);
  assert.equal(late.preserveExistingWork, false);
});
