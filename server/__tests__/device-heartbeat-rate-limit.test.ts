import request from "supertest";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createStudentToken } from "../jwt-utils";
import { createTestApp } from "./testUtils";
import { DEVICE_MAX_PER_MIN } from "../middleware/deviceRateLimit";

describe("device heartbeat rate limiting and gating", () => {
  let app: ReturnType<typeof request>;
  let server: Awaited<ReturnType<typeof createTestApp>>["server"];
  let storage: Awaited<ReturnType<typeof createTestApp>>["storage"];

  beforeAll(async () => {
    const created = await createTestApp();
    app = request(created.app);
    server = created.server;
    storage = created.storage;
    await created.storage.seedSchool({ id: "school-1" });
  });

  afterAll(() => {
    server.close();
  });

  it("returns 204 for rapid heartbeats and only persists once", async () => {
    const studentToken = createStudentToken({
      studentId: "student-rl-1",
      deviceId: "device-rl-1",
      schoolId: "school-1",
    });

    const addHeartbeatSpy = vi.spyOn(storage, "addHeartbeat");
    const payload = {
      deviceId: "device-rl-1",
      studentId: "student-rl-1",
      schoolId: "school-1",
      activeTabTitle: "Unit Test",
      activeTabUrl: "https://example.com",
      isSharing: false,
      screenLocked: false,
      flightPathActive: false,
      cameraActive: false,
    };

    const firstResponse = await app.post("/api/device/heartbeat")
      .set("Authorization", `Bearer ${studentToken}`)
      .send(payload);

    expect(firstResponse.status).toBe(200);

    const followUps = await Promise.all(
      Array.from({ length: 3 }).map(() =>
        app.post("/api/device/heartbeat")
          .set("Authorization", `Bearer ${studentToken}`)
          .send(payload)
      )
    );

    followUps.forEach((response) => {
      expect(response.status).toBe(204);
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(addHeartbeatSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 429 when exceeding the device rate limit", async () => {
    const studentToken = createStudentToken({
      studentId: "student-rl-2",
      deviceId: "device-rl-2",
      schoolId: "school-1",
    });

    const payload = {
      deviceId: "device-rl-2",
      studentId: "student-rl-2",
      schoolId: "school-1",
      activeTabTitle: "Unit Test",
      activeTabUrl: "https://example.com",
      isSharing: false,
      screenLocked: false,
      flightPathActive: false,
      cameraActive: false,
    };

    let lastResponse: request.Response | undefined;
    for (let i = 0; i < DEVICE_MAX_PER_MIN + 1; i += 1) {
      lastResponse = await app.post("/api/device/heartbeat")
        .set("Authorization", `Bearer ${studentToken}`)
        .send(payload);
    }

    expect(lastResponse?.status).toBe(429);
    expect(lastResponse?.body).toMatchObject({ error: "rate_limited" });
  });
});
