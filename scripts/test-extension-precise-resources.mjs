import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const fixtureBytes = readFileSync(join(root, 'server/__tests__/fixtures/restriction-resource-matcher-cases.json'));
assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'),
  '4ff6b3311bcf6937a776deb5c5eec60de98d7d74e9dc963bf762a842b440d243');
const fixtures = JSON.parse(fixtureBytes);
fixtures.match = fixtures.match.map(test => ({ ...test,
  resource: fixtures.resources[test.resource], expect: test.allowed }));
const profile = mkdtempSync(join(tmpdir(), 'classpilot-precise-resources-'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(path => path && existsSync(path));
assert.ok(executablePath, 'Chrome/Chromium is required');
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true,
    args: ['--headless=new', '--enable-automation', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  await context.route(/^https:\/\//, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><html><body><h1>Synthetic precise resource</h1></body></html>' }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await waitForExtensionWorkerDeclarations(worker);
  const result = await worker.evaluate(async ({ fixtures }) => {
    await authStateRestorePromise.catch(() => {});
    await classroomStateRestorePromise.catch(() => {});
    await studentAuthMutationTail.catch(() => {});
    CONFIG.autoRegistrationPaused = true;
    // The wake IIFE continues beyond storage restoration and can initialize
    // adaptive tracking/offscreen recovery. Fence its actual completion before
    // adopting the isolated fixture authority.
    const wakeDeadline = Date.now() + 20_000;
    while (!workerWakeSettled) {
      if (Date.now() >= wakeDeadline) throw new Error('Worker startup did not settle before the precise fixture');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (chromeProfileRegistrationInFlight) await chromeProfileRegistrationInFlight.catch(() => {});
    advanceStudentAuthMutationGeneration();
    // Only synthetic authority is installed; DNS and transports cannot reach a school.
    fetchWithBackoff = async () => new Response('{}', { status: 503 });
    sendHeartbeat = async () => {};
    connectWebSocket = async () => {};
    // Startup offscreen recovery can outlive the auth/storage restore promises
    // and reset transport readiness between native DNR awaits. Drain that real
    // startup operation before installing the isolated synthetic transport.
    recoverOffscreenWebSocketStatus = async () => true;
    if (wsConnectInFlight) await wsConnectInFlight.catch(() => {});
    scheduleEventHeartbeat = () => {};
    enqueueMonitoringEvent = async () => {};
    scheduleClassroomStateSideEffects = () => {};
    CONFIG.serverUrl = 'http://127.0.0.1:1';
    CONFIG.schoolId = 'precise-fixture-school';
    CONFIG.deviceId = 'precise-fixture-device';
    CONFIG.activeStudentId = 'precise-fixture-student';
    CONFIG.activeStudentSessionId = 'precise-fixture-student-session';
    CONFIG.studentToken = 'synthetic-token';
    CONFIG.identitySource = 'integration_test';
    studentAuthInvalidating = false;
    studentAuthCommitPending = false;
    activateAuthenticatedContext('precise-fixture-auth');
    const authContext = captureAuthenticatedContext('precise fixture');
    adoptLicenseState(true, 'active', authContext);
    schoolSettings = { enableTrackingHours: false, afterHoursMode: 'off' };
    schoolSettingsScope = schoolPolicyScopeForAuthContext(authContext);
    schoolSettingsFetchedAt = Date.now();
    // The install event's jittered tracking startup can run after worker wake.
    // Give its real cache read the same exact-scoped fixture policy as memory.
    await kv.set({ [SCHOOL_SETTINGS_CACHE_KEY]: schoolSettings, [SCHOOL_SETTINGS_SCOPE_KEY]: schoolSettingsScope,
      [SCHOOL_SETTINGS_FETCHED_AT_KEY]: schoolSettingsFetchedAt });
    trackingState = TRACKING_STATES.ACTIVE;
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3,
      acceptedCapabilities: ['scopedAuthorityChecksV1', 'preciseRestrictionResourcesV1', 'classroomStateV1'] }, authContext);
    const acknowledgements = [];
    const nativeSupport = chrome.declarativeNetRequest.isRegexSupported;
    const supportResults = [];
    chrome.declarativeNetRequest.isRegexSupported = async options => {
      const answer = await nativeSupport(options);
      supportResults.push({ regex: options.regex, ...answer });
      return answer;
    };
    wsConnected = true;
    wsSend = value => { acknowledgements.push(value); return true; };
    let revision = 1;
    const envelope = value => ({ studentId: authContext.studentId, studentSessionId: authContext.studentSessionId,
      exactBinding: { bindingVersion: 2, schoolId: authContext.schoolId, studentId: authContext.studentId,
        studentSessionId: authContext.studentSessionId, deviceId: authContext.deviceId, controlRevision: value } });
    const snapshot = (resources, value = revision++) => ({ schemaVersion: 1, revision: value,
      teachingSessionId: 'precise-fixture-class', receivedAt: Date.now(), hardExpiresAt: Date.now() + 60_000,
      restrictions: { flightPath: { active: true, allowedDomains: [], resources } } });
    const install = state => {
      const authorityEnvelope = envelope(state.revision);
      observeExactStudentControlRevision(authorityEnvelope, authContext, 'synthetic authenticated delivery');
      return applyClassroomState(state, { authContext, authorityEnvelope });
    };
    const checks = [];
    const fail = message => { throw new Error(message); };
    const require = (condition, message) => { if (!condition) fail(message); };
    const installedAction = async url => {
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      let matches;
      try { matches = await chrome.declarativeNetRequest.testMatchOutcome({ url, type: 'main_frame' }); }
      catch (error) {
        if (String(error.message).includes('Invalid test request URL')) return 'invalid_url';
        throw error;
      }
      const matching = matches.matchedRules.map(match => rules.find(rule => rule.id === match.ruleId)).filter(Boolean);
      matching.sort((a, b) => b.priority - a.priority || (a.action.type === 'allow' ? -1 : 1));
      return matching[0]?.action.type || 'none';
    };
    const valid = fixtures.match.filter(test => RuntimeCore.validateAllowedResource(test.resource));
    const resources = [...new Map(valid.map(test => [JSON.stringify(test.resource), test.resource])).values()];
    for (const resource of resources) {
      const state = snapshot([resource]);
      try { require((await install(state)).outcome === 'applied', 'valid precise resource was not applied'); }
      catch (error) { throw new Error(`${error.message}: ${JSON.stringify(supportResults)}`); }
      if (resource === resources[0]) {
        await initializeAdaptiveTracking('precise-fixture-cache-reload');
        require(schoolSettingsScope === schoolPolicyScopeForAuthContext(authContext)
          && [TRACKING_STATES.ACTIVE, TRACKING_STATES.IDLE].includes(trackingState) && wsConnected,
          `real cached-settings reload must preserve the scoped fixture policy and synthetic ACK transport: ${JSON.stringify({
            scopeCurrent: schoolSettingsScope === schoolPolicyScopeForAuthContext(authContext), trackingState, wsConnected,
            authenticated: hasStudentAuth(), currentLicense: currentLicenseIsActive(), invalidating: studentAuthInvalidating,
            wsConnectPending: Boolean(wsConnectInFlight), wakeSettled: workerWakeSettled })}`);
      }
      const landingUrl = RuntimeCore.canonicalUrlForResource(resource);
      require(await installedAction(landingUrl) !== 'block', `canonical landing blocked: ${landingUrl}`);
      for (const test of valid.filter(value => JSON.stringify(value.resource) === JSON.stringify(resource))) {
        const action = await installedAction(test.url);
        // A supported regex may intentionally be narrower than the matcher.
        if (!test.expect && resource.type !== 'website')
          require(action === 'block' || action === 'invalid_url', `DNR widened ${test.name}: ${test.url}`);
        if (/^https?:/i.test(test.url))
          require(RuntimeCore.decideNavigation(test.url, { classroomState: currentClassroomState }).allowed === test.expect,
            `navigation policy disagrees: ${test.name}`);
        checks.push({ name: test.name, matcher: RuntimeCore.isUrlAllowedByResource(test.url, resource), action });
        require(RuntimeCore.isUrlAllowedByResource(test.url, resource) === test.expect, `matcher: ${test.name}`);
      }
    }
    const video = valid.find(test => test.resource.provider === 'youtube').resource;
    const previous = snapshot([video]);
    await install(previous);
    const savedRules = JSON.stringify(await chrome.declarativeNetRequest.getDynamicRules());
    const savedStorage = JSON.stringify(await kv.get([CLASSROOM_STATE_STORAGE_KEY]));
    const savedExpiry = currentClassroomState.hardExpiresAt;
    const originalUpdate = chrome.declarativeNetRequest.updateDynamicRules;
    chrome.declarativeNetRequest.updateDynamicRules = async () => { throw new Error('synthetic atomic installation failure'); };
    const rejectedState = snapshot([resources.find(resource => resource.provider === 'google_docs')]);
    const ackStart = acknowledgements.length;
    let installationFailed = false;
    try { await install(rejectedState); }
    catch { installationFailed = true; }
    chrome.declarativeNetRequest.updateDynamicRules = originalUpdate;
    require(installationFailed, 'installation failure unexpectedly applied');
    require(currentClassroomState.revision === previous.revision, 'failed installation replaced accepted revision');
    require(currentClassroomState.hardExpiresAt === savedExpiry, 'failed installation extended old expiry');
    require(JSON.stringify(await chrome.declarativeNetRequest.getDynamicRules()) === savedRules, 'atomic failure changed rules');
    require(JSON.stringify(await kv.get([CLASSROOM_STATE_STORAGE_KEY])) === savedStorage, 'atomic failure changed persisted policy');
    const failedAcks = acknowledgements.slice(ackStart).filter(value => value.type === 'classroom-state-ack'
      && value.appliedRevision === rejectedState.revision);
    require(failedAcks.length > 0 && failedAcks.every(value => value.outcome === 'failed'),
      `installation failure did not acknowledge its exact revision failed: ${JSON.stringify({ connected: wsConnected, tracking: trackingState, settingsScoped: schoolSettingsScope === schoolPolicyScopeForAuthContext(authContext), outcome: lastClassroomStateOutcome, failedAcks, messages: acknowledgements.slice(-3) })}`);
    const saved = persistedClassroomStateSnapshot(currentClassroomState);
    require(saved.schemaVersion === 2 && saved.precisePersistenceVersion === 1, 'precise persistence lacks downgrade fence');
    require(RuntimeCore.normalizePersistedClassroomState(saved).restrictions.flightPath.resources.length === 1,
      'worker restore dropped precision');
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: [] }, authContext);
    let unnegotiatedFailed = false;
    try { await install(snapshot([video])); } catch { unnegotiatedFailed = true; }
    require(unnegotiatedFailed, 'unnegotiated replacement was applied');
    require(currentClassroomState.revision === previous.revision, 'capability withdrawal replaced valid policy');
    const restored = RuntimeCore.normalizePersistedClassroomState(saved);
    require((await applyClassroomState(restored, { authContext, trustedPersistedRestrictionSso: true, force: true })).outcome === 'applied',
      'previously owned precise policy could not be restored');
    // Native regex rejection must either use the safe narrower shape or retain the prior policy.
    supportedRestrictionRegexes.clear();
    const originalSupport = chrome.declarativeNetRequest.isRegexSupported;
    chrome.declarativeNetRequest.isRegexSupported = async () => ({ isSupported: false, reason: 'synthetic rejection' });
    let unsupportedFailed = false;
    try {
      adoptNegotiatedProtocolState({ serverProtocolVersion: 3,
        acceptedCapabilities: ['scopedAuthorityChecksV1', 'preciseRestrictionResourcesV1'] }, authContext);
      await install(snapshot([video]));
    } catch { unsupportedFailed = true; }
    chrome.declarativeNetRequest.isRegexSupported = originalSupport;
    supportedRestrictionRegexes.clear();
    require(unsupportedFailed, 'unsupported regex was installed');
    require(currentClassroomState.revision === previous.revision, 'unsupported regex replaced valid policy');
    const browserResource = resources.find(resource => resource.provider === 'google_docs');
    await install(snapshot([browserResource]));
    const browserDocumentUrl = RuntimeCore.canonicalUrlForResource(browserResource);
    return { fixtureChecks: checks.length, distinctResources: resources.length, failuresPreservedPolicy: true,
      honestAcknowledgements: true, cachedSettingsReload: true, downgradeAndRestore: true, capabilityWithdrawal: true,
      actualRules: (await chrome.declarativeNetRequest.getDynamicRules()).length,
      browserDocumentUrl, outsideDocumentUrl: browserDocumentUrl.replace(browserResource.resourceId, 'DifferentSyntheticDocumentId0123456789') };
  }, { fixtures });
  const page = await context.newPage();
  await page.goto(result.browserDocumentUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(url => history.pushState({}, '', url), result.outsideDocumentUrl);
  await page.waitForURL(result.browserDocumentUrl, { timeout: 10_000 });
  await page.evaluate(url => history.replaceState({}, '', url), result.outsideDocumentUrl);
  await page.waitForURL(result.browserDocumentUrl, { timeout: 10_000 });
  await page.evaluate(url => history.pushState({}, '', url), result.outsideDocumentUrl);
  await page.waitForURL(result.browserDocumentUrl, { timeout: 10_000 });
  const nativeLifecycle = await worker.evaluate(async () => {
    const nativeHistory = chrome.webNavigation.onHistoryStateUpdated.hasListener(handleBeforeNavigateForPolicy);
    const nativeFragment = chrome.webNavigation.onReferenceFragmentUpdated.hasListener(handleBeforeNavigateForPolicy);
    await clearTeacherSessionStateForSignOut({ emitEvent: false, reason: 'synthetic new-student boundary' });
    advanceStudentAuthMutationGeneration();
    CONFIG.activeStudentId = 'different-synthetic-student';
    CONFIG.activeStudentSessionId = 'different-synthetic-session';
    activateAuthenticatedContext('different-synthetic-auth');
    return { nativeHistory, nativeFragment, resources: flightPathResources.length,
      persisted: (await kv.get([CLASSROOM_STATE_STORAGE_KEY]))[CLASSROOM_STATE_STORAGE_KEY] || null,
      classroomRules: (await chrome.declarativeNetRequest.getDynamicRules())
        .filter(rule => RuntimeCore.isRuleInRange(rule.id, 'classroom')).length };
  });
  assert.equal(nativeLifecycle.nativeHistory, true);
  assert.equal(nativeLifecycle.nativeFragment, true);
  assert.equal(nativeLifecycle.resources, 0);
  assert.equal(nativeLifecycle.persisted, null);
  assert.equal(nativeLifecycle.classroomRules, 0);
  result.spaPushAndReplace = true;
  result.studentReplacementClearsResources = true;
  delete result.browserDocumentUrl;
  delete result.outsideDocumentUrl;
  console.log(JSON.stringify({ preciseBrowserAcceptance: result }, null, 2));
} finally {
  if (context) await context.close();
  rmSync(profile, { recursive: true, force: true });
}
