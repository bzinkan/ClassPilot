import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

class FakeTrack {
  stopped = false;
  onended: null | (() => void) = null;

  stop() {
    this.stopped = true;
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState = "new";
  remoteDescription: unknown = null;
  localDescription: { toJSON: () => Record<string, string> } | null = null;
  onicecandidate: null | ((event: unknown) => void) = null;
  onconnectionstatechange: null | (() => void) = null;
  closed = false;
  tracks: FakeTrack[] = [];
  restartCount = 0;

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTrack(track: FakeTrack) {
    this.tracks.push(track);
  }

  async setRemoteDescription(description: unknown) {
    this.remoteDescription = description;
  }

  async createAnswer() {
    return { type: "answer", sdp: "answer-sdp" };
  }

  async setLocalDescription() {
    this.localDescription = { toJSON: () => ({ type: "answer", sdp: "answer-sdp" }) };
  }

  async addIceCandidate() {}

  restartIce() {
    this.restartCount += 1;
  }

  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
}

describe("extension offscreen WebRTC lifecycle", () => {
  it("resets failed captures and tears down live view on intentional WebSocket close", async () => {
    const source = readFileSync(new URL("../../extension/offscreen.js", import.meta.url), "utf8");
    const sentMessages: Array<Record<string, unknown>> = [];
    const streams = [new FakeTrack(), new FakeTrack()];
    FakePeerConnection.instances = [];

    const context = vm.createContext({
      console: { log() {}, info() {}, warn() {}, error() {} },
      window: { addEventListener() {} },
      document: { readyState: "loading" },
      navigator: {
        mediaDevices: {
          getUserMedia: async () => {
            const track = streams.shift();
            if (!track) throw new Error("No test stream available");
            return { getTracks: () => [track] };
          },
          getDisplayMedia: async () => {
            throw new Error("Display fallback must not run in this test");
          },
        },
      },
      chrome: {
        runtime: {
          onMessage: { addListener() {} },
          sendMessage: (message: Record<string, unknown>) => {
            sentMessages.push(message);
            return Promise.resolve({ success: true });
          },
        },
        tabCapture: { getMediaStreamId() {} },
      },
      RTCPeerConnection: FakePeerConnection,
      RTCSessionDescription: class {
        value: unknown;
        constructor(value: unknown) { this.value = value; }
      },
      RTCIceCandidate: class {
        value: unknown;
        constructor(value: unknown) { this.value = value; }
      },
      WebSocket: class {
        static OPEN = 1;
        static CLOSED = 3;
      },
      URL,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    vm.runInContext(source, context);

    const identityA = {
      negotiationId: "negotiation-a",
      authContextId: "auth-a",
      authGeneration: 1,
      connectionGeneration: 1,
      serverOrigin: "https://school-pilot.net",
      studentSessionId: "student-session-a",
    };
    vm.runInContext(
      `proxyWs = { readyState: WebSocket.OPEN };
       proxyAuthenticated = true;
       proxyAuthContextId = ${JSON.stringify(identityA.authContextId)};
       proxyConnectionGeneration = ${identityA.connectionGeneration};
       proxyServerOrigin = ${JSON.stringify(identityA.serverOrigin)};`,
      context,
    );
    const firstStart = await vm.runInContext(
      `startScreenCapture('tab', 'stream-1', ${JSON.stringify(identityA)})`,
      context,
    );
    expect(firstStart).toEqual({ success: true });
    const firstPeer = FakePeerConnection.instances[0]!;
    await vm.runInContext(
      "handleSignal({ type: 'offer', from: 'teacher-a', negotiationId: 'negotiation-a', restartGeneration: 0, sdp: { type: 'offer', sdp: 'a' } })",
      context,
    );
    expect(firstPeer.remoteDescription).not.toBeNull();
    expect(vm.runInContext("offerProcessed", context)).toBe(true);

    firstPeer.connectionState = "failed";
    firstPeer.onconnectionstatechange?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(firstPeer.restartCount).toBe(1);
    expect(firstPeer.closed).toBe(false);
    vm.runInContext("attemptLiveViewIceRestart(peerConnection)", context);
    expect(firstPeer.restartCount).toBe(2);
    vm.runInContext("attemptLiveViewIceRestart(peerConnection)", context);
    expect(firstPeer.closed).toBe(true);
    expect(firstPeer.tracks[0]?.stopped).toBe(true);
    expect(vm.runInContext("offerProcessed", context)).toBe(false);
    expect(sentMessages.some((message) => message.type === "CONNECTION_FAILED")).toBe(true);

    const identityB = {
      ...identityA,
      negotiationId: "negotiation-b",
      authContextId: "auth-b",
      authGeneration: 2,
      connectionGeneration: 2,
      studentSessionId: "student-session-b",
    };
    vm.runInContext(
      `proxyWs = { readyState: WebSocket.OPEN };
       proxyAuthenticated = true;
       proxyAuthContextId = ${JSON.stringify(identityB.authContextId)};
       proxyConnectionGeneration = ${identityB.connectionGeneration};
       proxyServerOrigin = ${JSON.stringify(identityB.serverOrigin)};`,
      context,
    );
    const secondStart = await vm.runInContext(
      `startScreenCapture('tab', 'stream-2', ${JSON.stringify(identityB)})`,
      context,
    );
    expect(secondStart).toEqual({ success: true });
    const secondPeer = FakePeerConnection.instances[1]!;
    const staleOffer = await vm.runInContext(
      "handleSignal({ type: 'offer', from: 'teacher-a', negotiationId: 'negotiation-a', restartGeneration: 0, sdp: { type: 'offer', sdp: 'stale' } })",
      context,
    );
    expect(staleOffer).toEqual({ success: false, status: "stale-negotiation" });
    expect(secondPeer.remoteDescription).toBeNull();
    const secondOffer = await vm.runInContext(
      "handleSignal({ type: 'offer', from: 'teacher-b', negotiationId: 'negotiation-b', restartGeneration: 0, sdp: { type: 'offer', sdp: 'b' } })",
      context,
    );
    expect(secondOffer).toEqual({ success: true });
    expect(secondPeer.remoteDescription).not.toBeNull();
    expect(sentMessages.filter((message) => message.type === "ANSWER")).toHaveLength(2);
    expect(vm.runInContext("liveViewSetupTimer", context)).toBeNull();
    expect(vm.runInContext("Boolean(liveViewHardExpiryTimer)", context)).toBe(true);

    vm.runInContext("handleWsClose()", context);
    expect(secondPeer.closed).toBe(true);
    expect(secondPeer.tracks[0]?.stopped).toBe(true);
    expect(vm.runInContext("activeNegotiationId", context)).toBeNull();
    expect(vm.runInContext("liveViewSetupTimer", context)).toBeNull();
    expect(vm.runInContext("liveViewHardExpiryTimer", context)).toBeNull();
  });
});
