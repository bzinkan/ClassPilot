import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  authenticateWsClient,
  broadcastToTeachersLocal,
  registerWsClient,
  resetWsState,
} from "../ws-broadcast";

describe("ws broadcaster isolation", () => {
  afterEach(() => {
    resetWsState();
  });

  it("broadcasts only to teachers in the targeted school", () => {
    const schoolASocket = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    const schoolBSocket = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    registerWsClient(schoolASocket);
    registerWsClient(schoolBSocket);

    authenticateWsClient(schoolASocket, { role: "teacher", schoolId: "school-a", userId: "teacher-a" });
    authenticateWsClient(schoolBSocket, { role: "teacher", schoolId: "school-b", userId: "teacher-b" });

    broadcastToTeachersLocal("school-a", { type: "student-update" });

    expect(schoolASocket.send).toHaveBeenCalledTimes(1);
    expect(schoolBSocket.send).not.toHaveBeenCalled();
  });
});
