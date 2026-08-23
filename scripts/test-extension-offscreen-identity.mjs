import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const extensionPath = String(process.env.CLASSPILOT_EXTENSION_PATH || '').trim()
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH)
  : resolve(repoRoot, 'extension');
const source = readFileSync(resolve(extensionPath, 'offscreen.js'), 'utf8');
const relayed = [];
const runtimeListeners = [];
const timers = [];
let nextTimerId = 1;

function createDeferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

const mediaAwaitGates = {
  getUserMedia: null,
  getDisplayMedia: null,
};
const peerAwaitGates = {
  setRemoteDescription: null,
  createAnswer: null,
  setLocalDescription: null,
};
const peerMethodCalls = {
  setRemoteDescription: 0,
  createAnswer: 0,
  setLocalDescription: 0,
};
const createdStreams = [];
let nextStreamId = 1;

function createFakeStream(source) {
  const track = {
    onended: null,
    stopped: false,
    stop() { this.stopped = true; },
  };
  const stream = {
    id: `fake-stream-${nextStreamId++}`,
    source,
    track,
    getTracks: () => [track],
  };
  createdStreams.push(stream);
  return stream;
}

async function acquireFakeStream(source) {
  const stream = createFakeStream(source);
  const gate = mediaAwaitGates[source];
  if (gate) await gate.promise;
  return stream;
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closed = false;
  }

  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('socket is not open');
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

class FakePeerConnection {
  constructor(configuration) {
    this.configuration = configuration;
    this.connectionState = 'new';
    this.remoteDescription = null;
    this.localDescription = null;
    this.restartCount = 0;
    this.closed = false;
  }

  addTrack() {}
  addIceCandidate() { return Promise.resolve(); }
  setRemoteDescription(description) {
    peerMethodCalls.setRemoteDescription += 1;
    const gate = peerAwaitGates.setRemoteDescription;
    if (!gate) {
      this.remoteDescription = description;
      return Promise.resolve();
    }
    return gate.promise.then(() => {
      this.remoteDescription = description;
    });
  }
  createAnswer() {
    peerMethodCalls.createAnswer += 1;
    const answer = { type: 'answer', sdp: 'answer-sdp' };
    const gate = peerAwaitGates.createAnswer;
    return gate ? gate.promise.then(() => answer) : Promise.resolve(answer);
  }
  setLocalDescription(description) {
    peerMethodCalls.setLocalDescription += 1;
    const gate = peerAwaitGates.setLocalDescription;
    const applyDescription = () => {
      this.localDescription = { ...description, toJSON: () => ({ ...description }) };
    };
    if (!gate) {
      applyDescription();
      return Promise.resolve();
    }
    return gate.promise.then(applyDescription);
  }
  getStats() {
    return Promise.resolve(new Map([
      ['transport-1', { type: 'transport', selectedCandidatePairId: 'pair-1' }],
      ['pair-1', { type: 'candidate-pair', selected: true, localCandidateId: 'local-1' }],
      ['local-1', {
        type: 'local-candidate',
        candidateType: 'relay',
        protocol: 'tcp',
        url: 'turns:turn.example:443',
      }],
    ]));
  }
  restartIce() { this.restartCount += 1; }
  close() { this.closed = true; this.connectionState = 'closed'; }
}

const sandbox = {
  AbortController,
  Blob,
  Date,
  Error,
  JSON,
  Map,
  Math,
  Promise,
  Set,
  URL,
  WebSocket: FakeWebSocket,
  RTCPeerConnection: FakePeerConnection,
  RTCSessionDescription: class RTCSessionDescription {
    constructor(value) { Object.assign(this, value); }
  },
  RTCIceCandidate: class RTCIceCandidate {
    constructor(value) { Object.assign(this, value); }
  },
  clearInterval() {},
  clearTimeout(id) {
    const timer = timers.find((item) => item.id === id);
    if (timer) timer.cleared = true;
  },
  console: {
    error() {},
    info() {},
    log() {},
    warn() {},
  },
  document: { readyState: 'loading' },
  navigator: {
    mediaDevices: {
      getUserMedia: async () => acquireFakeStream('getUserMedia'),
      getDisplayMedia: async () => acquireFakeStream('getDisplayMedia'),
    },
  },
  setInterval() { return 1; },
  setTimeout(callback, delay) {
    const timer = { id: nextTimerId++, callback, delay, cleared: false };
    timers.push(timer);
    return timer.id;
  },
  window: { addEventListener() {} },
  chrome: {
    runtime: {
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        },
      },
      sendMessage(message) {
        relayed.push(message);
        return Promise.resolve();
      },
    },
  },
};
sandbox.globalThis = sandbox;
const context = vm.createContext(sandbox);
vm.runInContext(source, context, { filename: 'extension/offscreen.js' });

const evaluate = (expression) => vm.runInContext(expression, context);

let nextRaceIdentity = 20;
function createLiveIdentity(label) {
  const generation = nextRaceIdentity++;
  return {
    negotiationId: `negotiation-${label}`,
    authContextId: `live-context-${label}`,
    authGeneration: generation,
    connectionGeneration: generation,
    serverOrigin: 'https://school-pilot.net',
    studentSessionId: `student-session-${label}`,
  };
}

function startLiveView(identity, { mode = 'tab', streamId = 'stream-id' } = {}) {
  return evaluate(`startScreenCapture(
    ${JSON.stringify(mode)},
    ${JSON.stringify(streamId)},
    ${JSON.stringify(identity)},
    ${Date.now() + 90_000},
    ${Date.now() + 15 * 60_000},
    [{ urls: 'turns:turn.example:443', username: 'opaque', credential: 'secret' }],
    ${Date.now() + 10 * 60_000}
  )`);
}

async function waitForPeerMethod(method, previousCallCount) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (peerMethodCalls[method] > previousCallCount) return;
    await Promise.resolve();
  }
  assert.fail(`Timed out waiting for ${method}`);
}

assert.equal(runtimeListeners.length, 1);
assert.throws(
  () => evaluate(`handleWsConnect(
    'wss://school-pilot.net/ws',
    { type: 'auth' },
    1,
    'context-a',
    'https://different.example'
  )`),
  /exact authentication context/i,
);

evaluate(`handleWsConnect(
  'wss://school-pilot.net/ws',
  { type: 'auth', studentToken: 'not-logged' },
  1,
  'context-a',
  'https://school-pilot.net'
)`);
evaluate(`proxyWs.readyState = WebSocket.OPEN; proxyWs.onopen()`);
let status = evaluate('wsStatus()');
assert.equal(status.connectionGeneration, 1);
assert.equal(status.authContextId, 'context-a');
assert.equal(status.serverOrigin, 'https://school-pilot.net');
assert.equal(status.transportOpen, true);
assert.equal(
  evaluate(`handleWsSend('current-frame', 1, 'context-a', 'https://school-pilot.net').success`),
  true,
);
assert.equal(
  evaluate(`handleWsSend('wrong-context', 1, 'context-b', 'https://school-pilot.net').success`),
  false,
);

evaluate(`handleWsConnect(
  'wss://school-pilot.net/ws',
  { type: 'auth', studentToken: 'also-not-logged' },
  2,
  'context-b',
  'https://school-pilot.net'
)`);
evaluate(`proxyWs.readyState = WebSocket.OPEN; proxyWs.onopen()`);
status = evaluate('wsStatus()');
assert.equal(status.connectionGeneration, 2);
assert.equal(status.authContextId, 'context-b');

const staleClose = evaluate(
  `handleWsClose(1, 'context-a', 'https://school-pilot.net')`,
);
assert.equal(staleClose.transportOpen, true);
assert.equal(staleClose.authContextId, 'context-b');

const currentClose = evaluate(
  `handleWsClose(2, 'context-b', 'https://school-pilot.net')`,
);
assert.equal(currentClose.transportOpen, false);
assert.equal(currentClose.authContextId, null);
assert.ok(relayed.some((message) => (
  message.type === 'WS_EVENT'
  && message.event === 'open'
  && message.connectionGeneration === 2
  && message.authContextId === 'context-b'
  && message.serverOrigin === 'https://school-pilot.net'
)));

const liveIdentity = {
  negotiationId: 'negotiation-a',
  authContextId: 'live-context-a',
  authGeneration: 7,
  connectionGeneration: 3,
  serverOrigin: 'https://school-pilot.net',
  studentSessionId: 'student-session-a',
};
const startResult = await evaluate(`startScreenCapture(
  'tab',
  'stream-id',
  ${JSON.stringify(liveIdentity)},
  ${Date.now() + 90_000},
  ${Date.now() + 15 * 60_000},
  [{ urls: 'turns:turn.example:443', username: 'opaque', credential: 'secret' }],
  ${Date.now() + 10 * 60_000}
)`);
assert.equal(startResult.success, true);
assert.equal(evaluate('peerConnection.configuration.iceServers[0].urls'), 'turns:turn.example:443');
assert.equal(evaluate(`liveViewIdentityMatches(${JSON.stringify(liveIdentity)})`), true);
assert.equal(evaluate(`liveViewIdentityMatches(${JSON.stringify({
  ...liveIdentity,
  authContextId: 'stale-context',
})})`), false);

evaluate(`peerConnection.connectionState = 'connected'; peerConnection.onconnectionstatechange()`);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(relayed.some((message) => (
  message.type === 'LIVE_VIEW_ATTEMPT_TERMINAL'
  && message.negotiationId === 'negotiation-a'
  && message.attempt === 0
  && message.outcome === 'connected'
  && message.selectedCandidateType === 'relay'
  && message.relayTransport === 'tls'
  && Number.isInteger(message.connectionTimeMs)
)));

const initialOffer = await evaluate(`handleSignal({
  type: 'offer',
  negotiationId: 'negotiation-a',
  restartGeneration: 0,
  from: 'teacher',
  sdp: { type: 'offer', sdp: 'offer-sdp' }
})`);
assert.equal(initialOffer.success, true);
assert.ok(relayed.some((message) => (
  message.type === 'ANSWER'
  && message.negotiationId === 'negotiation-a'
  && message.authContextId === 'live-context-a'
  && message.restartGeneration === 0
)));

evaluate(`peerConnection.connectionState = 'disconnected'; peerConnection.onconnectionstatechange()`);
const graceTimer = [...timers].reverse().find((timer) => !timer.cleared && timer.delay === 5000);
assert.ok(graceTimer, 'a disconnected peer must receive a five-second grace timer');
graceTimer.callback();
assert.equal(evaluate('peerConnection.restartCount'), 1);
assert.equal(evaluate('activeLiveViewRestartGeneration'), 1);
assert.ok(relayed.some((message) => (
  message.type === 'ICE_RESTART_REQUIRED'
  && message.restartGeneration === 1
  && message.authContextId === 'live-context-a'
)));

const staleRestartSignal = await evaluate(`handleSignal({
  type: 'ice',
  negotiationId: 'negotiation-a',
  restartGeneration: 0,
  candidate: { candidate: 'stale' }
})`);
assert.equal(staleRestartSignal.status, 'stale-negotiation');
const currentRestartOffer = await evaluate(`handleSignal({
  type: 'offer',
  negotiationId: 'negotiation-a',
  restartGeneration: 1,
  from: 'teacher',
  sdp: { type: 'offer', sdp: 'restart-offer' }
})`);
assert.equal(currentRestartOffer.success, true);

evaluate('attemptLiveViewIceRestart(peerConnection)');
assert.equal(evaluate('peerConnection.restartCount'), 2);
evaluate('attemptLiveViewIceRestart(peerConnection)');
assert.equal(evaluate('activeNegotiationId'), null);
assert.ok(relayed.some((message) => (
  message.type === 'CONNECTION_FAILED'
  && message.reason === 'ice-restart-exhausted'
  && message.authContextId === 'live-context-a'
)));

async function assertMediaAwaitIsFenced(method, startOptions) {
  const identityA = createLiveIdentity(`${method}-a`);
  const identityB = createLiveIdentity(`${method}-b`);
  const gate = createDeferred();
  const streamCountBefore = createdStreams.length;
  mediaAwaitGates[method] = gate;

  const staleStart = startLiveView(identityA, startOptions);
  assert.equal(
    createdStreams.length,
    streamCountBefore + 1,
    `${method} must reach its deterministic pause point`,
  );
  const detachedStream = createdStreams.at(-1);

  mediaAwaitGates[method] = null;
  const currentStart = await startLiveView(identityB);
  assert.equal(currentStart.success, true);
  const currentPeer = evaluate('peerConnection');
  const currentStream = evaluate('localStream');
  const currentSetupTimer = evaluate('liveViewSetupTimer');
  const relayCountAfterTransition = relayed.length;

  gate.resolve();
  const staleResult = await staleStart;
  assert.equal(staleResult.status, 'stale-negotiation');
  assert.equal(evaluate('activeNegotiationId'), identityB.negotiationId);
  assert.equal(evaluate('peerConnection'), currentPeer);
  assert.equal(evaluate('localStream'), currentStream);
  assert.equal(evaluate('liveViewSetupTimer'), currentSetupTimer);
  assert.equal(timers.find((timer) => timer.id === currentSetupTimer)?.cleared, false);
  assert.equal(detachedStream.track.stopped, true);
  assert.equal(currentStream.track.stopped, false);
  assert.equal(
    relayed.slice(relayCountAfterTransition).some((message) => (
      message.type === 'CAPTURE_ERROR'
      || message.authContextId === identityA.authContextId
    )),
    false,
    `${method} completion must not emit under either stale or current authority`,
  );
}

await assertMediaAwaitIsFenced('getUserMedia', { mode: 'tab', streamId: 'stale-stream-id' });
await assertMediaAwaitIsFenced('getDisplayMedia', { mode: 'screen', streamId: null });

async function assertRtcAwaitIsFenced(method) {
  const identityA = createLiveIdentity(`${method}-a`);
  const identityB = createLiveIdentity(`${method}-b`);
  const initialStart = await startLiveView(identityA);
  assert.equal(initialStart.success, true);
  const stalePeer = evaluate('peerConnection');
  const gate = createDeferred();
  const previousCallCount = peerMethodCalls[method];
  peerAwaitGates[method] = gate;
  const relayCountBeforeOffer = relayed.length;

  const staleOffer = evaluate(`handleSignal({
    type: 'offer',
    negotiationId: ${JSON.stringify(identityA.negotiationId)},
    restartGeneration: 0,
    from: 'teacher-a',
    sdp: { type: 'offer', sdp: ${JSON.stringify(`offer-${method}`)} }
  })`);
  await waitForPeerMethod(method, previousCallCount);

  peerAwaitGates[method] = null;
  const currentStart = await startLiveView(identityB);
  assert.equal(currentStart.success, true);
  const currentPeer = evaluate('peerConnection');
  const currentStream = evaluate('localStream');
  const currentSetupTimer = evaluate('liveViewSetupTimer');

  gate.resolve();
  const staleResult = await staleOffer;
  assert.equal(staleResult.status, 'stale-negotiation');
  assert.equal(stalePeer.closed, true);
  assert.equal(evaluate('activeNegotiationId'), identityB.negotiationId);
  assert.equal(evaluate('peerConnection'), currentPeer);
  assert.equal(evaluate('localStream'), currentStream);
  assert.equal(currentPeer.remoteDescription, null);
  assert.equal(currentPeer.localDescription, null);
  assert.equal(evaluate('liveViewSetupTimer'), currentSetupTimer);
  assert.equal(timers.find((timer) => timer.id === currentSetupTimer)?.cleared, false);
  assert.equal(
    relayed.slice(relayCountBeforeOffer).some((message) => message.type === 'ANSWER'),
    false,
    `${method} completion must not answer under the replacement authority`,
  );
}

await assertRtcAwaitIsFenced('setRemoteDescription');
await assertRtcAwaitIsFenced('createAnswer');
await assertRtcAwaitIsFenced('setLocalDescription');

console.log('ClassPilot offscreen WebSocket and Live View identity test passed.');
