import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const extensionPath = String(process.env.CLASSPILOT_EXTENSION_PATH || '').trim()
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH)
  : resolve(repoRoot, 'extension');
const popupSource = await readFile(resolve(extensionPath, 'popup.js'), 'utf8');
const contentSource = await readFile(resolve(extensionPath, 'content.js'), 'utf8');
const serviceWorkerSource = await readFile(resolve(extensionPath, 'service-worker.js'), 'utf8');
assert.doesNotMatch(contentSource, /includeConfig/,
  'content-facing auth requests must never request internal configuration');
assert.doesNotMatch(serviceWorkerSource, /response\.config\s*=\s*CONFIG|config:\s*CONFIG/,
  'runtime replies must never expose the mutable internal configuration object');
const pendingMessages = [];
function takePendingMessage(type) {
  const index = pendingMessages.findIndex((entry) => entry.message?.type === type);
  assert.notEqual(index, -1, `expected a pending ${type} message`);
  return pendingMessages.splice(index, 1)[0];
}
const rendered = {
  school: '',
  student: '',
  classId: '',
  detectedName: '',
  detectedEmail: '',
};

function elementFor(id) {
  const propertyById = {
    'school-name': 'school',
    'student-name-display': 'student',
    'class-id-display': 'classId',
    'detected-student-name': 'detectedName',
    'detected-student-email': 'detectedEmail',
  };
  const property = propertyById[id];
  return {
    classList: { add() {}, remove() {} },
    addEventListener() {},
    set textContent(value) {
      if (property) rendered[property] = String(value);
    },
    get textContent() {
      return property ? rendered[property] : '';
    },
  };
}

const context = vm.createContext({
  console,
  alert() {},
  setInterval() { return 1; },
  clearInterval() {},
  setTimeout() { return 1; },
  clearTimeout() {},
  document: {
    addEventListener() {},
    getElementById: elementFor,
  },
  chrome: {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        pendingMessages.push({ message, callback });
      },
    },
    storage: {
      onChanged: { addListener() {} },
      local: { async get() { return {}; } },
    },
  },
});

vm.runInContext(`${popupSource}\n;globalThis.__popupIdentityTest = {\n  refreshPopupConfig,\n  refreshAuthState,\n  bumpEpoch() { popupStudentActionEpoch += 1; },\n  snapshot() { return { currentConfig, currentAuthState, popupStudentActionEpoch }; },\n};`, context, {
  filename: 'extension/popup.js',
});

const hooks = context.__popupIdentityTest;

hooks.refreshPopupConfig();
assert.equal(pendingMessages[0].message.type, 'get-config');
hooks.bumpEpoch();
pendingMessages.shift().callback({
  config: {
    schoolId: 'school-a',
    studentName: 'Student A',
    studentEmail: 'student-a@example.invalid',
    classId: 'class-a',
  },
});
assert.equal(hooks.snapshot().currentConfig, null, 'retired get-config callback must be discarded');
assert.equal(rendered.student, '', 'retired get-config callback must not paint student A');

hooks.refreshPopupConfig();
const currentConfigRequest = pendingMessages.shift();
currentConfigRequest.callback({
  config: {
    schoolId: 'school-b',
    studentName: 'Student B',
    studentEmail: 'student-b@example.invalid',
    classId: 'class-b',
    hasStudentToken: true,
  },
});
assert.equal(hooks.snapshot().currentConfig.studentName, 'Student B');
assert.equal(rendered.student, 'Student B');
const retiredAuthRequest = takePendingMessage('get-auth-state');
assert.equal('includeConfig' in retiredAuthRequest.message, false);
hooks.bumpEpoch();
retiredAuthRequest.callback({
  success: true,
  state: { authRequired: false, studentName: 'Student A' },
  config: {
    studentToken: 'must-not-be-consumed',
    deviceId: 'must-not-be-consumed',
  },
});
assert.equal(hooks.snapshot().currentAuthState, null, 'retired auth-state callback must be discarded');
assert.equal(rendered.student, 'Student B', 'retired auth-state callback must not repaint identity');

hooks.refreshAuthState();
const currentRequest = takePendingMessage('get-auth-state');
assert.equal('includeConfig' in currentRequest.message, false);
currentRequest.callback({
  success: true,
  state: { authRequired: false, studentName: 'Student B' },
  config: {
    studentToken: 'must-not-be-consumed',
    deviceId: 'must-not-be-consumed',
  },
});
assert.equal(hooks.snapshot().currentConfig.studentName, 'Student B');
assert.equal(hooks.snapshot().currentAuthState.studentName, 'Student B');
assert.equal(rendered.school, 'school-b');
assert.equal(rendered.student, 'Student B');
assert.equal(rendered.detectedEmail, 'student-b@example.invalid');

console.log('ClassPilot popup identity race tests passed.');
