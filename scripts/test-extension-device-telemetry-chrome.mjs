import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

// This is a functional offscreen/worker transport check with one localhost
// client, not a capacity campaign. The browser cannot resolve external hosts.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(repo, 'extension'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(value => value && existsSync(value));
assert.ok(executablePath, 'A local Chromium executable is required');
const profile = mkdtempSync(join(tmpdir(), 'classpilot-device-telemetry-'));
const frames = [], requests = [];
let replyEnabled = true, browser;
const http = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    requests.push({ path: request.url, body: body ? JSON.parse(body) : null });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true,"transport":"http"}');
  });
});
const sockets = new WebSocketServer({ server: http, path: '/ws' });
sockets.on('connection', socket => socket.on('message', raw => {
  const frame = JSON.parse(raw.toString());
  if (frame.type !== 'device-telemetry') return;
  frames.push(frame);
  if (replyEnabled) socket.send(JSON.stringify({
    type: 'device-telemetry-result', operationId: frame.operationId, kind: frame.kind,
    status: 200, body: { ok: true, transport: 'websocket' },
    exactBinding: { studentId: 'synthetic-student', studentSessionId: 'synthetic-session' },
  }));
}));
await new Promise(resolveListen => http.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${http.address().port}`;

try {
  browser = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true,
    args: ['--headless=new', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker', { timeout: 10_000 });
  await waitForExtensionWorkerDeclarations(worker);
  const diagnostics = [];
  worker.on('console', message => {
    if (message.text().includes('Offscreen') || message.text().includes('WebSocket')) diagnostics.push(message.text());
  });
  await worker.evaluate(async origin => {
    await authStateRestorePromise;
    await classroomStateRestorePromise;
    await studentAuthMutationTail;
    const controller = new AbortController();
    globalThis.__telemetryFixture = { controller, auth: {
      authContextId: 'synthetic-auth', serverOrigin: origin, studentId: 'synthetic-student',
      studentSessionId: 'synthetic-session', studentToken: 'synthetic-token', signal: controller.signal,
    } };
    // Replace authority resolution only in this isolated functional browser.
    // The production telemetry adapter, offscreen owner, frame send/receive,
    // correlation, byte limits and HTTP recovery are all exercised unchanged.
    captureAuthenticatedContext = () => globalThis.__telemetryFixture.auth;
    assertAuthenticatedContextCurrent = context => {
      if (context !== globalThis.__telemetryFixture.auth || context.signal.aborted) {
        throw authContextSuperseded('synthetic telemetry');
      }
      return context;
    };
    hasNegotiatedCapability = name => ['scopedAuthorityChecksV1', 'deviceTelemetryTransportV1'].includes(name);
    CONFIG.serverUrl = origin;
    wsConnectionGeneration = 101;
    wsTransportIdentity = { connectionGeneration: 101, authContextId: 'synthetic-auth', serverOrigin: origin };
    await sendToOffscreen({ type: 'WS_CONNECT', url: origin.replace('http:', 'ws:') + '/ws',
      connectionGeneration: 101, authContextId: 'synthetic-auth', serverOrigin: origin });
  }, origin);
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await worker.evaluate(async () => queryOffscreenWebSocketStatus());
    if (status?.transportOpen === true) break;
    if (attempt === 99) throw new Error('Local offscreen WebSocket did not open: ' + JSON.stringify({ status, diagnostics }));
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  await worker.evaluate(() => { wsConnected = true; wsAuthenticatedGeneration = 101; });
  const runHeartbeat = () => worker.evaluate(async origin => {
    const response = await fetchWithBackoff(origin + '/api/device/heartbeat', {
      method: 'POST', body: JSON.stringify({ activeTabTitle: 'Synthetic lesson' }),
      signal: globalThis.__telemetryFixture.controller.signal,
    }, { maxAttempts: 1, respectGlobalBackoff: false,
      deviceTelemetry: { kind: 'heartbeat', authContext: globalThis.__telemetryFixture.auth } });
    return { status: response.status, body: await response.json() };
  }, origin);
  const healthy = await runHeartbeat();
  assert.equal(healthy.body.transport, 'websocket', JSON.stringify({ frames: frames.length, diagnostics,
    state: await worker.evaluate(() => ({ wsConnected, wsConnectionGeneration, wsAuthenticatedGeneration, wsTransportIdentity })) }));
  assert.equal(requests.filter(request => request.path === '/api/device/heartbeat').length, 0);
  assert.equal(frames.length, 1);

  replyEnabled = false;
  const recovered = await runHeartbeat();
  assert.equal(recovered.body.transport, 'http');
  const recovery = requests.find(request => request.path === '/api/device/heartbeat');
  assert.equal(recovery.body.telemetryOperationId, frames.at(-1).operationId);
  assert.equal(recovery.body.activeTabTitle, 'Synthetic lesson');
  console.log('PASS real Chrome: offscreen WebSocket canonical result and same-ID HTTP recovery');
} finally {
  await browser?.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolveClose => sockets.close(resolveClose));
  await new Promise(resolveClose => http.close(resolveClose));
  const resolvedProfile = resolve(profile);
  const tempRoot = resolve(tmpdir()) + sep;
  assert.ok(resolvedProfile.startsWith(tempRoot) && resolvedProfile.includes('classpilot-device-telemetry-'));
  rmSync(resolvedProfile, { recursive: true, force: true });
}
