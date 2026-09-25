import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// This isolates native browser API compatibility. The other Chrome suites test
// the shipped worker and UI; this fixture does not claim those behavioral tests.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(repoRoot, 'extension'));
const sourceManifest = JSON.parse(readFileSync(join(sourceRoot, 'manifest.json'), 'utf8'));
const configured = String(process.env.CLASSPILOT_CHROME_PATH || '').trim();
if (configured) assert.ok(existsSync(configured), 'CLASSPILOT_CHROME_PATH must identify an existing browser');
const executablePath = configured || [chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(path => existsSync(path));
assert.ok(executablePath, 'Install Chromium or set CLASSPILOT_CHROME_PATH');
for (const permission of ['alarms', 'offscreen', 'tabCapture', 'activeTab', 'tabs']) {
  assert.ok(sourceManifest.permissions.includes(permission), `Shipped manifest must include ${permission}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'classpilot-browser-api-'));
const extension = join(scratch, 'extension');
mkdirSync(extension);
writeFileSync(join(extension, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'ClassPilot native API compatibility fixture', version: sourceManifest.version,
  minimum_chrome_version: sourceManifest.minimum_chrome_version,
  permissions: ['alarms', 'offscreen', 'tabCapture', 'activeTab', 'tabs'],
  background: { service_worker: 'worker.js' },
}));
writeFileSync(join(extension, 'worker.js'), `
globalThis.offscreenReady = false;
chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'api-smoke-offscreen-ready') globalThis.offscreenReady = true;
});
globalThis.apiSmokeReady = true;
`);
writeFileSync(join(extension, 'offscreen.html'), '<!doctype html><script src="offscreen.js"></script>');
writeFileSync(join(extension, 'offscreen.js'), `
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type !== 'api-smoke-offscreen') return;
  (async () => {
    const peer = new RTCPeerConnection({ iceServers: [] });
    peer.close();
    const result = { getUserMedia: typeof navigator.mediaDevices?.getUserMedia,
      getDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia,
      peerClosed: peer.connectionState === 'closed' };
    if (message.streamId) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } } });
      result.liveVideo = stream.getVideoTracks().some(track => track.readyState === 'live');
      stream.getTracks().forEach(track => track.stop());
    }
    respond({ success: true, ...result });
  })().catch(error => respond({ success: false, errorName: error.name }));
  return true;
});
chrome.runtime.sendMessage({ type: 'api-smoke-offscreen-ready' });
`);

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>ClassPilot capture API fixture</title><p>Local synthetic capture target</p>');
});
async function boundedApiCheck(operation) {
  let timeout;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Native browser API smoke did not settle within 20 seconds')), 20_000);
    })]);
  } finally { clearTimeout(timeout); }
}
let context;
try {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
    executablePath, headless: true,
    args: ['--headless=new', '--disable-background-networking', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const page = context.pages()[0] || await context.newPage();
  const cdp = await context.newCDPSession(page);
  const { product } = await cdp.send('Browser.getVersion');
  await cdp.detach();
  const major = Number(product.match(/\/(\d+)/)?.[1]);
  assert.ok(major >= 120, `Browser API smoke requires Chrome 120+, got ${product}`);
  const expectedMajor = Number(process.env.CLASSPILOT_EXPECT_CHROME_MAJOR || 0);
  if (expectedMajor) assert.equal(major, expectedMajor, 'Configured browser major must match the requested validation target');
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  const result = await boundedApiCheck(worker.evaluate(async targetUrl => {
    const workerDeadline = Date.now() + 5_000;
    while (!globalThis.apiSmokeReady && Date.now() < workerDeadline) await new Promise(done => setTimeout(done, 20));
    if (!globalThis.apiSmokeReady) throw new Error('API fixture worker did not initialize');
    const alarmName = 'classpilot-api-smoke-half-minute';
    await chrome.alarms.create(alarmName, { periodInMinutes: 0.5 });
    const alarm = await chrome.alarms.get(alarmName);
    await chrome.alarms.clear(alarmName);
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'],
      justification: 'Verify extension worker and offscreen media API compatibility on a local synthetic page' });
    const deadline = Date.now() + 5_000;
    while (!globalThis.offscreenReady && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
    if (!globalThis.offscreenReady) throw new Error('The native offscreen document did not signal readiness');
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    const tabs = await chrome.tabs.query({});
    const target = tabs.find(tab => tab.url?.startsWith(targetUrl));
    if (!target) throw new Error('Local capture target tab was not found');
    let capture = 'permission-denied';
    let streamId = null;
    const request = chrome.tabCapture.getMediaStreamId({ targetTabId: target.id });
    if (!request || typeof request.then !== 'function') throw new Error('tabCapture.getMediaStreamId must return a Promise');
    try {
      streamId = await request;
      if (typeof streamId !== 'string' || !streamId) throw new Error('Native capture returned an invalid stream identifier');
      capture = 'stream-issued';
    } catch (error) {
      // No toolbar invocation or permission-bypassing flag is synthesized. An
      // ordinary activeTab denial is an expected result, not media validation.
      if (!/not been invoked|activeTab permission|not allowed to capture/i.test(String(error.message))) throw error;
    }
    const media = await chrome.runtime.sendMessage({ type: 'api-smoke-offscreen', streamId });
    return { alarmPeriod: alarm?.periodInMinutes, offscreenContexts: contexts.length, capture, media };
  }, origin));
  assert.equal(result.alarmPeriod, 0.5, 'Chrome must retain the requested 30-second alarm period');
  assert.equal(result.offscreenContexts, 1, 'Worker must discover the native offscreen document');
  assert.equal(result.media?.success, true, 'Worker must receive the offscreen media API response');
  assert.equal(result.media.getUserMedia, 'function');
  assert.equal(result.media.getDisplayMedia, 'function');
  assert.equal(result.media.peerClosed, true);
  if (result.capture === 'stream-issued') assert.equal(result.media.liveVideo, true, 'A normally granted worker stream must be consumable offscreen');
  console.log(JSON.stringify({ browser: product, extensionVersion: sourceManifest.version,
    alarmPeriodInMinutes: result.alarmPeriod, offscreenMessaging: 'passed', webRtcConstruction: 'passed',
    tabCapture: result.capture === 'stream-issued' ? 'worker-stream-consumed-offscreen' : 'Promise API present; normal invocation permission required',
    limits: 'Unpacked API smoke verifies the retained alarm period, not production alarm firing cadence. No permission or user-gesture bypass flags.' }));
} finally {
  await context?.close();
  await new Promise(done => server.close(done));
  const withinTemp = relative(resolve(tmpdir()), resolve(scratch));
  assert.ok(withinTemp.startsWith('classpilot-browser-api-') && !withinTemp.includes(sep), 'Cleanup must stay in this test’s temporary directory');
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
