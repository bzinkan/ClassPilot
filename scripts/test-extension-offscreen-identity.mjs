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
const intervals = [];
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
  clearInterval(id) {
    const interval = intervals.find((item) => item.id === id);
    if (interval) interval.cleared = true;
  },
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
  setInterval(callback, delay) {
    const interval = { id: nextTimerId++, callback, delay, cleared: false };
    intervals.push(interval);
    return interval.id;
  },
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
    startGeneration: generation,
    authContextId: `live-context-${label}`,
    authGeneration: generation,
    connectionGeneration: generation,
    serverOrigin: 'https://school-pilot.net',
    studentSessionId: `student-session-${label}`,
  };
}

function activateAuthenticatedProxy(identity) {
  evaluate(`handleWsConnect(
    'wss://school-pilot.net/ws',
    { type: 'auth' },
    ${JSON.stringify(identity.connectionGeneration)},
    ${JSON.stringify(identity.authContextId)},
    ${JSON.stringify(identity.serverOrigin)}
  )`);
  evaluate(`proxyWs.readyState = WebSocket.OPEN; proxyWs.onopen()`);
  evaluate(`proxyWs.onmessage({ data: ${JSON.stringify(JSON.stringify({ type: 'auth-success' }))} })`);
  const proxyStatus = evaluate('wsStatus()');
  assert.equal(proxyStatus.connectionGeneration, identity.connectionGeneration);
  assert.equal(proxyStatus.authContextId, identity.authContextId);
  assert.equal(proxyStatus.serverOrigin, identity.serverOrigin);
  assert.equal(proxyStatus.transportOpen, true);
  assert.equal(proxyStatus.authenticated, true);
}

function dispatchOffscreenMessage(message) {
  return new Promise((resolveResponse, rejectResponse) => {
    try {
      const asynchronous = runtimeListeners[0](message, {}, resolveResponse);
      assert.equal(asynchronous, true);
    } catch (error) {
      rejectResponse(error);
    }
  });
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
  startGeneration: 7,
  authContextId: 'live-context-a',
  authGeneration: 7,
  connectionGeneration: 3,
  serverOrigin: 'https://school-pilot.net',
  studentSessionId: 'student-session-a',
};
const streamCountBeforeUnauthenticatedStart = createdStreams.length;
const unauthenticatedStart = await startLiveView(liveIdentity);
assert.equal(unauthenticatedStart.success, false);
assert.equal(unauthenticatedStart.status, 'stale-negotiation');
assert.equal(createdStreams.length, streamCountBeforeUnauthenticatedStart);

activateAuthenticatedProxy(liveIdentity);
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

const activePeerBeforeExpiredRequests = evaluate('peerConnection');
for (const expiryCase of [
  {
    setupExpiresAt: Date.now() - 1,
    expiresAt: Date.now() + 15 * 60_000,
    iceConfigurationExpiresAt: Date.now() + 10 * 60_000,
  },
  {
    setupExpiresAt: Date.now() + 90_000,
    expiresAt: Date.now() - 1,
    iceConfigurationExpiresAt: Date.now() + 10 * 60_000,
  },
  {
    setupExpiresAt: Date.now() + 90_000,
    expiresAt: Date.now() + 15 * 60_000,
    iceConfigurationExpiresAt: Date.now() - 1,
  },
]) {
  const expiredIdentity = {
    ...liveIdentity,
    negotiationId: `expired-${expiryCase.setupExpiresAt}-${expiryCase.expiresAt}`,
    startGeneration: 8,
  };
  const expiredResult = await evaluate(`startScreenCapture(
    'tab',
    'expired-stream-id',
    ${JSON.stringify(expiredIdentity)},
    ${JSON.stringify(expiryCase.setupExpiresAt)},
    ${JSON.stringify(expiryCase.expiresAt)},
    [{ urls: 'turns:turn.example:443', username: 'opaque', credential: 'secret' }],
    ${JSON.stringify(expiryCase.iceConfigurationExpiresAt)}
  )`);
  assert.equal(expiredResult.success, false);
  assert.equal(expiredResult.status, 'expired-request');
  assert.equal(evaluate('activeNegotiationId'), liveIdentity.negotiationId);
  assert.equal(evaluate('peerConnection'), activePeerBeforeExpiredRequests);
}

const staleStartResult = await evaluate(`startScreenCapture(
  'tab',
  'stale-stream-id',
  ${JSON.stringify({
    ...liveIdentity,
    negotiationId: 'stale-start-negotiation',
    startGeneration: 6,
  })},
  ${Date.now() + 90_000},
  ${Date.now() + 15 * 60_000},
  [{ urls: 'turns:turn.example:443', username: 'opaque', credential: 'secret' }],
  ${Date.now() + 10 * 60_000}
)`);
assert.equal(staleStartResult.success, false);
assert.equal(staleStartResult.status, 'stale-negotiation');
assert.equal(evaluate('activeNegotiationId'), liveIdentity.negotiationId);
assert.equal(evaluate('peerConnection'), activePeerBeforeExpiredRequests);

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

  activateAuthenticatedProxy(identityA);
  const staleStart = startLiveView(identityA, startOptions);
  assert.equal(
    createdStreams.length,
    streamCountBefore + 1,
    `${method} must reach its deterministic pause point`,
  );
  const detachedStream = createdStreams.at(-1);

  mediaAwaitGates[method] = null;
  activateAuthenticatedProxy(identityB);
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
  activateAuthenticatedProxy(identityA);
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
  activateAuthenticatedProxy(identityB);
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

const captureBeforeSocketReplacement = evaluate('peerConnection');
const streamBeforeSocketReplacement = evaluate('localStream');
const cancelledLiveViewIdentity = evaluate('({ ...latestLiveViewIdentity })');
const streamCountBeforeSocketReplacement = createdStreams.length;
evaluate(`handleWsConnect(
  'wss://school-pilot.net/ws',
  { type: 'auth' },
  99,
  'replacement-worker-auth-context',
  'https://school-pilot.net'
)`);
assert.equal(captureBeforeSocketReplacement.closed, true);
assert.equal(streamBeforeSocketReplacement.track.stopped, true);
assert.equal(evaluate('activeNegotiationId'), null);
assert.equal(evaluate('peerConnection'), null);
assert.equal(evaluate('localStream'), null);
const delayedCancelledStart = await startLiveView(cancelledLiveViewIdentity);
assert.equal(delayedCancelledStart.success, false);
assert.equal(delayedCancelledStart.status, 'stale-negotiation');
const delayedOlderStart = await startLiveView({
  ...cancelledLiveViewIdentity,
  negotiationId: 'older-cancelled-negotiation',
  startGeneration: cancelledLiveViewIdentity.startGeneration - 1,
});
assert.equal(delayedOlderStart.success, false);
assert.equal(delayedOlderStart.status, 'stale-negotiation');
assert.equal(createdStreams.length, streamCountBeforeSocketReplacement);

const stopBeforeStartIdentity = {
  negotiationId: 'stop-before-first-start',
  startGeneration: 10,
  authContextId: 'stop-before-start-context',
  authGeneration: 0,
  connectionGeneration: 100,
  serverOrigin: 'https://school-pilot.net',
  studentSessionId: 'stop-before-start-session',
};
activateAuthenticatedProxy(stopBeforeStartIdentity);
const streamCountBeforeStopTombstone = createdStreams.length;
const inactiveStop = await dispatchOffscreenMessage({
  type: 'STOP_SHARE',
  ...stopBeforeStartIdentity,
});
assert.equal(inactiveStop.success, true);
assert.equal(evaluate('activeNegotiationId'), null);
const delayedStoppedStart = await startLiveView(stopBeforeStartIdentity);
assert.equal(delayedStoppedStart.success, false);
assert.equal(delayedStoppedStart.status, 'stale-negotiation');
const delayedPredecessorStart = await startLiveView({
  ...stopBeforeStartIdentity,
  negotiationId: 'stop-before-first-start-older',
  startGeneration: stopBeforeStartIdentity.startGeneration - 1,
});
assert.equal(delayedPredecessorStart.success, false);
assert.equal(delayedPredecessorStart.status, 'stale-negotiation');
assert.equal(createdStreams.length, streamCountBeforeStopTombstone);

const preRestartIdentity = {
  negotiationId: 'pre-worker-restart-high-generation',
  startGeneration: 900,
  authContextId: 'restart-stable-auth-context',
  authGeneration: 17,
  connectionGeneration: 200,
  serverOrigin: 'https://school-pilot.net',
  studentSessionId: 'restart-stable-student-session',
};
activateAuthenticatedProxy(preRestartIdentity);
const preRestartStart = await startLiveView(preRestartIdentity);
assert.equal(preRestartStart.success, true);
const orphanedStream = evaluate('localStream');
const orphanedPeer = evaluate('peerConnection');
const recoveredStatus = evaluate('wsStatus()');
assert.deepEqual(
  JSON.parse(JSON.stringify(recoveredStatus.liveViewIdentity)),
  {
    ...preRestartIdentity,
    restartGeneration: 0,
  },
);

const recoveredStop = await dispatchOffscreenMessage({
  type: 'STOP_SHARE',
  ...recoveredStatus.liveViewIdentity,
});
assert.equal(recoveredStop.success, true);
assert.equal(orphanedStream.track.stopped, true);
assert.equal(orphanedPeer.closed, true);
assert.equal(evaluate('activeNegotiationId'), null);

const restartedWorkerIdentity = {
  negotiationId: 'post-worker-restart-low-generation',
  startGeneration: 1,
  authContextId: preRestartIdentity.authContextId,
  authGeneration: 0,
  connectionGeneration: 201,
  serverOrigin: preRestartIdentity.serverOrigin,
  studentSessionId: preRestartIdentity.studentSessionId,
};
activateAuthenticatedProxy(restartedWorkerIdentity);
const restartedWorkerStart = await startLiveView(restartedWorkerIdentity);
assert.equal(restartedWorkerStart.success, true);
const restartedStream = evaluate('localStream');
assert.equal(restartedStream.track.stopped, false);
const streamCountAfterRestart = createdStreams.length;

const delayedPreRestartStart = await startLiveView(preRestartIdentity);
assert.equal(delayedPreRestartStart.success, false);
assert.equal(delayedPreRestartStart.status, 'stale-negotiation');
const retiredSocketStart = await startLiveView({
  ...preRestartIdentity,
  negotiationId: 'retired-socket-newer-start',
  startGeneration: preRestartIdentity.startGeneration + 1,
});
assert.equal(retiredSocketStart.success, false);
assert.equal(retiredSocketStart.status, 'stale-negotiation');
assert.equal(createdStreams.length, streamCountAfterRestart);
assert.equal(evaluate('localStream'), restartedStream);
assert.equal(restartedStream.track.stopped, false);

const cadenceIssuedAt = Date.now();
const invalidCadence = await dispatchOffscreenMessage({
  type: 'SCREENSHOT_CADENCE_START',
  cadenceId: 'cadence-invalid',
  generation: 1,
  issuedAt: cadenceIssuedAt,
  expiresAt: Date.now() + 60_000,
  intervalMs: 4_000,
});
assert.equal(invalidCadence.success, false);
assert.equal(invalidCadence.status, 'invalid-cadence');

const cadenceA = await dispatchOffscreenMessage({
  type: 'SCREENSHOT_CADENCE_START',
  cadenceId: 'cadence-active-a',
  generation: 2,
  issuedAt: cadenceIssuedAt + 1,
  expiresAt: Date.now() + 60_000,
  intervalMs: 5_000,
});
assert.equal(cadenceA.success, true);
const cadenceAInterval = intervals.at(-1);
assert.equal(cadenceAInterval.delay, 5_000);
assert.equal(cadenceAInterval.cleared, false);
const cadenceASchedule = JSON.parse(JSON.stringify(evaluate('screenshotCadenceSchedule')));
const intervalCountBeforeIdempotentStart = intervals.length;
const idempotentCadenceA = await dispatchOffscreenMessage({
  type: 'SCREENSHOT_CADENCE_START',
  ...cadenceASchedule,
});
assert.equal(idempotentCadenceA.success, true);
assert.equal(idempotentCadenceA.status, 'active');
assert.equal(intervals.length, intervalCountBeforeIdempotentStart);
const mutatedReplayCadenceA = await dispatchOffscreenMessage({
  type: 'SCREENSHOT_CADENCE_START',
  ...cadenceASchedule,
  expiresAt: cadenceASchedule.expiresAt + 1,
});
assert.equal(mutatedReplayCadenceA.success, false);
assert.equal(mutatedReplayCadenceA.status, 'stale-cadence');
const cadenceATicksBefore = relayed.filter((message) => (
  message.type === 'SCREENSHOT_CADENCE_TICK'
  && message.cadenceId === 'cadence-active-a'
)).length;
cadenceAInterval.callback();
cadenceAInterval.callback();
assert.equal(
  relayed.filter((message) => (
    message.type === 'SCREENSHOT_CADENCE_TICK'
    && message.cadenceId === 'cadence-active-a'
  )).length,
  cadenceATicksBefore + 1,
  'the offscreen scheduler must drop overlapping ticks instead of queuing captures',
);
await Promise.resolve();
await Promise.resolve();

const staleCadence = await dispatchOffscreenMessage({
  type: 'SCREENSHOT_CADENCE_START',
  cadenceId: 'cadence-stale-a',
  generation: 3,
  issuedAt: cadenceIssuedAt,
  expiresAt: Date.now() + 60_000,
  intervalMs: 5_000,
});
assert.equal(staleCadence.success, false);
assert.equal(staleCadence.status, 'stale-cadence');
assert.equal(cadenceAInterval.cleared, false);

const cadenceB = await dispatchOffscreenMessage({
  type: 'SCREENSHOT_CADENCE_START',
  cadenceId: 'cadence-active-b',
  generation: 4,
  issuedAt: cadenceIssuedAt + 2,
  expiresAt: Date.now() + 60_000,
  intervalMs: 5_000,
});
assert.equal(cadenceB.success, true);
assert.equal(cadenceAInterval.cleared, true);
const cadenceBInterval = intervals.at(-1);
assert.equal(cadenceBInterval.cleared, false);

const staleStop = await dispatchOffscreenMessage({
  type: 'SCREENSHOT_CADENCE_STOP',
  cadenceId: 'cadence-active-a',
  generation: 5,
  issuedAt: cadenceIssuedAt + 1,
});
assert.equal(staleStop.success, false);
assert.equal(staleStop.status, 'stale-cadence');
assert.equal(cadenceBInterval.cleared, false);

const currentStop = await dispatchOffscreenMessage({
  type: 'SCREENSHOT_CADENCE_STOP',
  cadenceId: 'cadence-active-b',
  generation: 5,
  issuedAt: cadenceIssuedAt + 3,
});
assert.equal(currentStop.success, true);
assert.equal(currentStop.status, 'stopped');
assert.equal(cadenceBInterval.cleared, true);
assert.equal(evaluate('screenshotCadenceSchedule'), null);

const cadenceC = await dispatchOffscreenMessage({
  type: 'SCREENSHOT_CADENCE_START',
  cadenceId: 'cadence-active-c',
  generation: 6,
  issuedAt: cadenceIssuedAt + 4,
  expiresAt: Date.now() + 60_000,
  intervalMs: 5_000,
});
assert.equal(cadenceC.success, true);
const cadenceCInterval = intervals.at(-1);
const cadenceCExpiry = timers.at(-1);
evaluate('screenshotCadenceTickInFlight = true');
cadenceCExpiry.callback();
await Promise.resolve();
await Promise.resolve();
assert.equal(cadenceCInterval.cleared, true);
assert.equal(evaluate('screenshotCadenceSchedule'), null);
assert.ok(relayed.some((message) => (
  message.type === 'SCREENSHOT_CADENCE_EXPIRED'
  && message.cadenceId === 'cadence-active-c'
  && message.generation === 6
)));

console.log('ClassPilot offscreen WebSocket, Live View identity, and screenshot cadence test passed.');
