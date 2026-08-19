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
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    vm.runInContext(source, context);

    const firstStart = await vm.runInContext(
      "startScreenCapture('device-1', 'tab', 'stream-1', 'negotiation-a')",
      context,
    );
    expect(firstStart).toEqual({ success: true });
    const firstPeer = FakePeerConnection.instances[0]!;
    await vm.runInContext(
      "handleSignal({ type: 'offer', from: 'teacher-a', negotiationId: 'negotiation-a', sdp: { type: 'offer', sdp: 'a' } })",
      context,
    );
    expect(firstPeer.remoteDescription).not.toBeNull();
    expect(vm.runInContext("offerProcessed", context)).toBe(true);

    firstPeer.connectionState = "failed";
    firstPeer.onconnectionstatechange?.();
    expect(firstPeer.closed).toBe(true);
    expect(firstPeer.tracks[0]?.stopped).toBe(true);
    expect(vm.runInContext("offerProcessed", context)).toBe(false);
    expect(sentMessages.some((message) => message.type === "CONNECTION_FAILED")).toBe(true);

    const secondStart = await vm.runInContext(
      "startScreenCapture('device-1', 'tab', 'stream-2', 'negotiation-b')",
      context,
    );
    expect(secondStart).toEqual({ success: true });
    const secondPeer = FakePeerConnection.instances[1]!;
    const staleOffer = await vm.runInContext(
      "handleSignal({ type: 'offer', from: 'teacher-a', negotiationId: 'negotiation-a', sdp: { type: 'offer', sdp: 'stale' } })",
      context,
    );
    expect(staleOffer).toEqual({ success: false, status: "stale-negotiation" });
    expect(secondPeer.remoteDescription).toBeNull();
    const secondOffer = await vm.runInContext(
      "handleSignal({ type: 'offer', from: 'teacher-b', negotiationId: 'negotiation-b', sdp: { type: 'offer', sdp: 'b' } })",
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
