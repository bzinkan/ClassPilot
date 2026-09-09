// Actual page scripts/Chromium DOM, with a local deterministic worker contract.
// The full extension suites separately verify isolated-world and frame security.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const files = ['auth-gate-transport.js', 'page-lifecycle.js', 'auth-gate-bootstrap.js', 'content.js'];
const sources = Object.fromEntries(files.map(file => [file, readFileSync(process.env.CLASSPILOT_EXTENSION_PATH
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH, file) : new URL(`../extension/${file}`, import.meta.url), 'utf8')]));

test('real page scripts preserve same-version UI, retire callbacks, and rehydrate classroom state after replacement', { timeout: 45000 }, async () => {
  const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(path => path && existsSync(path));
  assert.ok(executablePath, 'A local Chromium binary is required');
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html><body><input id="page-draft" value="unsaved page work"></body></html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => {
      const listeners = new Set(), changes = new Set(), messages = [], pending = [];
      const context = { authContextId: 'auth-fixture', schoolId: 'school-fixture', studentId: 'student-fixture', studentSessionId: 'session-fixture' };
      const fabContext = { binding: 'fab-fixture', activeSessionIds: ['class-fixture'], teachingSessionId: 'class-fixture', revision: 1 };
      const fixture = window.lifecycleFixture = { version: '2.8.7', listeners, changes, messages, pending, context,
        holdAuth: false, endsAt: Date.now() + 120000, oldFab: null, oldPoll: null };
      const responseFor = message => {
        if (message.type === 'get-auth-state') return { success: true, state: fixture.signedOut
          ? { phase: 'ready', authRequired: true, revision: 2, fastAuthGateEnabled: true, loginMethod: 'email_id' }
          : { phase: 'authenticated', authRequired: false, revision: 1, fastAuthGateEnabled: true } };
        if (message.type === 'get-student-message-context') return { success: true, studentMessageContext: context, fabBinding: 'fab-fixture' };
        if (message.type === 'validate-student-message-context') return { success: true, current: true, fabBinding: 'fab-fixture' };
        if (message.type === 'get-student-session-ui-state') return { success: true, fabBinding: 'fab-fixture', stored: {
          fabContextV1: fabContext, fabChatContextV1: fabContext,
          fabStateV1: { messagingEnabled: true, handRaisingEnabled: true, revision: 1 }, fabChatMessages: [] } };
        if (message.type === 'get-classroom-overlay-state') return { success: true, studentMessageContext: context, fabBinding: 'fab-fixture',
          classroomState: { restrictions: { attentionMode: { active: true, message: 'Teacher attention fixture' } } },
          overlays: { timer: { endsAt: fixture.endsAt, message: 'Timer fixture' },
            poll: { pollId: 'poll-fixture', question: 'Fixture question?', options: ['A', 'B'], teachingSessionId: 'class-fixture', expiresAt: fixture.endsAt } },
          fabContext, fabState: { messagingEnabled: true, handRaisingEnabled: true, revision: 1 } };
        return { success: true };
      };
      window.chrome = { runtime: { id: 'fixture-extension', getManifest: () => ({ version: fixture.version }),
        getURL: path => `${location.origin}/${path}`,
        sendMessage(message, callback) { messages.push(message.type); const deliver = () => callback?.(responseFor(message));
          if (fixture.holdAuth && message.type === 'get-auth-state') pending.push(deliver); else queueMicrotask(deliver); },
        onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } },
        storage: { onChanged: { addListener: fn => changes.add(fn), removeListener: fn => changes.delete(fn) },
          managed: { get: (_keys, callback) => queueMicrotask(() => callback({})) },
          local: { get: (_keys, callback) => queueMicrotask(() => callback({})), set: (_values, callback) => callback?.() },
          session: { get: (_keys, callback) => queueMicrotask(() => callback({})) } } };
      fixture.originalCameraMethod = navigator.mediaDevices.getUserMedia;
    });
    const install = async () => { for (const file of files) await page.addScriptTag({ content: sources[file] }); };
    await install();
    await page.waitForSelector('#classpilot-poll-overlay');
    await page.evaluate(() => {
      lifecycleFixture.oldFab = document.getElementById('classpilot-fab-container');
      lifecycleFixture.oldPoll = document.getElementById('classpilot-poll-overlay');
      document.getElementById('classpilot-fab-chat-input').value = 'draft chat text';
    });
    for (let index = 0; index < 5; index++) await install();
    assert.deepEqual(await page.evaluate(() => ({
      sameFab: lifecycleFixture.oldFab === document.getElementById('classpilot-fab-container'),
      samePoll: lifecycleFixture.oldPoll === document.getElementById('classpilot-poll-overlay'),
      draft: document.getElementById('classpilot-fab-chat-input').value,
      listeners: lifecycleFixture.listeners.size, changes: lifecycleFixture.changes.size,
      signouts: lifecycleFixture.messages.filter(type => type === 'student-sign-out').length,
    })), { sameFab: true, samePoll: true, draft: 'draft chat text', listeners: 2, changes: 2, signouts: 0 });

    // Hold an old auth callback, retire both owners, then deliver it after disposal.
    await page.evaluate(() => { lifecycleFixture.holdAuth = true; ClassPilotPageLifecycle.reconcile(); });
    await page.evaluate(() => {
      ClassPilotPageLifecycle.dispose();
      lifecycleFixture.pending.splice(0).forEach(deliver => deliver());
      lifecycleFixture.holdAuth = false;
    });
    assert.deepEqual(await page.evaluate(() => ({
      roots: document.querySelectorAll('[id^="classpilot-"]').length,
      listeners: lifecycleFixture.listeners.size, changes: lifecycleFixture.changes.size,
      draft: document.getElementById('page-draft').value,
      cameraRestored: navigator.mediaDevices.getUserMedia === lifecycleFixture.originalCameraMethod,
    })), { roots: 0, listeners: 0, changes: 0, draft: 'unsaved page work', cameraRestored: true });

    await page.evaluate(() => { lifecycleFixture.version = '2.8.8'; });
    await install();
    await page.waitForSelector('#classpilot-poll-overlay');
    assert.deepEqual(await page.evaluate(() => ({
      attention: document.getElementById('classpilot-attention-overlay')?.textContent.includes('Teacher attention fixture'),
      timer: !!document.getElementById('classpilot-timer-overlay'), poll: !!document.getElementById('classpilot-poll-overlay'),
      draft: document.getElementById('page-draft').value, listeners: lifecycleFixture.listeners.size,
      versions: ClassPilotPageLifecycle.inspect().map(owner => owner.version),
      signouts: lifecycleFixture.messages.filter(type => type === 'student-sign-out').length,
    })), { attention: true, timer: true, poll: true, draft: 'unsaved page work', listeners: 2, versions: ['2.8.8', '2.8.8'], signouts: 0 });

    // Detached temporary owned roots are not retained by cleanup bookkeeping.
    await page.evaluate(() => {
      const owner = ClassPilotPageLifecycle.begin('cleanup-test');
      window.cleanupFixture = owner;
      for (let index = 0; index < 2000; index++) {
        const node = document.createElement('div'); owner.scope.ownNode(node); node.remove();
      }
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForFunction(() => cleanupFixture.controller.inspect().cleanupCount <= 2);
    await page.evaluate(() => cleanupFixture.controller.dispose());

    // A replacement's extension frame may fail to load/acknowledge. The local
    // endpoint deliberately serves a plain page, so it cannot complete the nonce
    // handshake. Protection must exist during bootstrap and after its deadline.
    await page.evaluate(() => { lifecycleFixture.signedOut = true; ClassPilotPageLifecycle.reconcile(); });
    await page.waitForSelector('#classpilot-auth-gate');
    await page.evaluate(() => {
      lifecycleFixture.version = '2.8.9'; lifecycleFixture.holdAuth = true;
      lifecycleFixture.oldGate = document.getElementById('classpilot-auth-gate');
      lifecycleFixture.pageInputEvents = 0;
      document.getElementById('page-draft').addEventListener('input', () => lifecycleFixture.pageInputEvents++);
    });
    await page.addScriptTag({ content: sources['auth-gate-bootstrap.js'] });
    // The new content bundle has not run yet and the auth callback is withheld.
    assert.equal(await page.evaluate(() => document.body.inert), true);
    await page.keyboard.type('must not reach the page');
    assert.equal(await page.evaluate(() => document.getElementById('page-draft').value), 'unsaved page work');
    await page.evaluate(() => { lifecycleFixture.holdAuth = false; lifecycleFixture.pending.splice(0).forEach(deliver => deliver()); });
    await page.addScriptTag({ content: sources['content.js'] });
    await page.waitForFunction(() => document.getElementById('classpilot-auth-gate')?.dataset.classpilotAuthFrameStatus === 'unavailable', null, { timeout: 15000 });
    await page.keyboard.type('still must not reach the page');
    assert.deepEqual(await page.evaluate(() => ({
      protected: document.body.inert,
      closedShadow: document.getElementById('classpilot-auth-gate').shadowRoot === null,
      newGate: lifecycleFixture.oldGate !== document.getElementById('classpilot-auth-gate'),
      inputEvents: lifecycleFixture.pageInputEvents,
      draft: document.getElementById('page-draft').value,
      listeners: lifecycleFixture.listeners.size,
      reloads: lifecycleFixture.messages.filter(type => type === 'classpilot-request-page-reload').length,
      signouts: lifecycleFixture.messages.filter(type => type === 'student-sign-out').length,
    })), { protected: true, closedShadow: true, newGate: true, inputEvents: 0, draft: 'unsaved page work', listeners: 2, reloads: 0, signouts: 0 });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
