import request from "supertest";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
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

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("blocks heartbeats for canceled schools", async () => {
    await storage.updateSchool("school-1", { planStatus: "canceled" });

    const studentToken = createStudentToken({
      studentId: "student-canceled-1",
      deviceId: "device-canceled-1",
      schoolId: "school-1",
    });

    const response = await app.post("/api/device/heartbeat")
      .set("Authorization", `Bearer ${studentToken}`)
      .send({
        deviceId: "device-canceled-1",
        studentId: "student-canceled-1",
        schoolId: "school-1",
        activeTabTitle: "Unit Test",
        activeTabUrl: "https://example.com",
        isSharing: false,
        screenLocked: false,
        flightPathActive: false,
        cameraActive: false,
      });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: "school_not_entitled" });

    await storage.updateSchool("school-1", { planStatus: "active" });
  });

  it("strips heavy heartbeat fields for basic tier", async () => {
    await storage.updateSchool("school-1", { planTier: "basic", planStatus: "active" });
    const studentToken = createStudentToken({
      studentId: "student-basic-1",
      deviceId: "device-basic-1",
      schoolId: "school-1",
    });

    const addHeartbeatSpy = vi.spyOn(storage, "addHeartbeat");

    const response = await app.post("/api/device/heartbeat")
      .set("Authorization", `Bearer ${studentToken}`)
      .send({
        deviceId: "device-basic-1",
        studentId: "student-basic-1",
        schoolId: "school-1",
        activeTabTitle: "Unit Test",
        activeTabUrl: "https://example.com",
        isSharing: false,
        screenLocked: false,
        flightPathActive: false,
        cameraActive: false,
        allOpenTabs: [{ url: "https://example.com", title: "Example" }],
        tabs: ["https://example.com"],
        urls: ["https://example.com"],
      });

    expect(response.status).toBe(204);
    expect(addHeartbeatSpy).toHaveBeenCalled();
    const [, allOpenTabs] = addHeartbeatSpy.mock.calls[0] ?? [];
    expect(allOpenTabs).toBeUndefined();

  });

  it("allows full heartbeat fields for pro tier", async () => {
    await storage.updateSchool("school-1", { planTier: "pro", planStatus: "active" });
    const studentToken = createStudentToken({
      studentId: "student-pro-1",
      deviceId: "device-pro-1",
      schoolId: "school-1",
    });

    const addHeartbeatSpy = vi.spyOn(storage, "addHeartbeat");

    const response = await app.post("/api/device/heartbeat")
      .set("Authorization", `Bearer ${studentToken}`)
      .send({
        deviceId: "device-pro-1",
        studentId: "student-pro-1",
        schoolId: "school-1",
        activeTabTitle: "Unit Test",
        activeTabUrl: "https://example.com",
        isSharing: false,
        screenLocked: false,
        flightPathActive: false,
        cameraActive: false,
        allOpenTabs: [{ url: "https://example.com", title: "Example" }],
        tabs: ["https://example.com"],
        urls: ["https://example.com"],
      });

    expect(response.status).toBe(200);
    expect(addHeartbeatSpy).toHaveBeenCalled();
    const [, allOpenTabs] = addHeartbeatSpy.mock.calls[0] ?? [];
    expect(allOpenTabs).toEqual([{ url: "https://example.com", title: "Example" }]);

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
